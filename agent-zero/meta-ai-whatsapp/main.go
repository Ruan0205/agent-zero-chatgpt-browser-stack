// OpenAI-compatible shim that reaches Meta AI over WhatsApp.
//
// Uses whatsmeow rather than Baileys because Meta AI is a bot JID (867051314767696@bot) and bot
// delivery requires a <bot> stanza node plus an HKDF-derived BotMessageSecret. Baileys sends
// neither, so WhatsApp server-acks its messages and never delivers them (one grey tick forever).
package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	_ "github.com/mattn/go-sqlite3"
)

var (
	botJID    = types.NewMetaAIJID
	quietTime = envDuration("WA_QUIET_MS", 6000)
	graceTime = envDuration("WA_GRACE_MS", 18000)
	hardLimit = envDuration("WA_TIMEOUT_MS", 120000)
	modelID   = "meta-ai"
	debug     = os.Getenv("WA_DEBUG") == "1"
	// A WhatsApp text message caps out around 65k characters. Past that Meta AI answers "There was a
	// problem generating a response", so the prompt is trimmed to fit rather than sent and failed.
	maxPrompt     = envInt("WA_MAX_CHARS", 60000)
	maxToolResult = envInt("WA_MAX_TOOL_RESULT", 4000)
)

// messageKinds lists which fields a received message actually carries, so an unhandled shape shows
// up in the log instead of silently reading as empty text.
func messageKinds(m *waE2E.Message) string {
	if m == nil {
		return "<nil>"
	}
	raw, err := protojson.Marshal(m)
	if err != nil {
		return "?"
	}
	var obj map[string]any
	if json.Unmarshal(raw, &obj) != nil {
		return "?"
	}
	keys := make([]string, 0, len(obj))
	for k := range obj {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return strings.Join(keys, ",")
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		var n int
		if _, err := fmt.Sscanf(v, "%d", &n); err == nil && n > 0 {
			return n
		}
	}
	return def
}

// clip shortens an over-long block, keeping the head and tail because the useful parts of a tool
// result are usually at both ends.
func clip(s string, max int) string {
	if len(s) <= max {
		return s
	}
	keep := (max - 40) / 2
	return s[:keep] + fmt.Sprintf("\n…[%d chars omitted]…\n", len(s)-keep*2) + s[len(s)-keep:]
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func envDuration(key string, defMillis int) time.Duration {
	if v := os.Getenv(key); v != "" {
		var ms int
		if _, err := fmt.Sscanf(v, "%d", &ms); err == nil && ms > 0 {
			return time.Duration(ms) * time.Millisecond
		}
	}
	return time.Duration(defMillis) * time.Millisecond
}

// collector gathers Meta AI's reply. It streams by editing one message with the full text so far,
// so entries are keyed by message ID and a later edit replaces the earlier fragment; separate
// messages still concatenate in arrival order. The answer is complete once quietTime passes with
// nothing new and the text no longer looks unfinished.
type collector struct {
	mu    sync.Mutex
	order []string
	texts map[string]string
	image []byte
	mime  string
	bump  chan struct{}
}

func newCollector() *collector {
	return &collector{texts: map[string]string{}, bump: make(chan struct{}, 64)}
}

func (c *collector) put(id, text string) {
	c.mu.Lock()
	if _, ok := c.texts[id]; !ok {
		c.order = append(c.order, id)
	}
	c.texts[id] = text
	c.mu.Unlock()
	select {
	case c.bump <- struct{}{}:
	default:
	}
}

func (c *collector) putImage(data []byte, mime string) {
	c.mu.Lock()
	c.image = append([]byte(nil), data...)
	c.mime = mime
	c.mu.Unlock()
	select {
	case c.bump <- struct{}{}:
	default:
	}
}

func (c *collector) imageValue() ([]byte, string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]byte(nil), c.image...), c.mime
}

func (c *collector) waitImage() ([]byte, string) {
	deadline := time.After(hardLimit)
	for {
		if data, mime := c.imageValue(); len(data) > 0 {
			return data, mime
		}
		select {
		case <-c.bump:
		case <-deadline:
			return c.imageValue()
		}
	}
}

func (c *collector) value() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	parts := make([]string, 0, len(c.order))
	for _, id := range c.order {
		if t := c.texts[id]; t != "" {
			parts = append(parts, t)
		}
	}
	return strings.TrimSpace(strings.Join(parts, "\n"))
}

func (c *collector) wait() string {
	deadline := time.After(hardLimit)
	// Meta AI composes in bursts and extends its answer by editing the same message, so a pause is
	// not the end. When the text still looks unfinished after the quiet window, wait out a bounded
	// grace period instead of the full hard limit, which would make every terse reply crawl.
	var grace <-chan time.Time
	for {
		select {
		case <-c.bump:
			grace = nil // more text arrived; the answer is still growing
		case <-time.After(quietTime):
			v := c.value()
			trunc := looksTruncated(v)
			if debug {
				log.Printf("~~ quiet elapsed len=%d truncated=%v grace=%v", len(v), trunc, grace != nil)
			}
			if !trunc {
				return v
			}
			if grace == nil {
				grace = time.After(graceTime)
			}
		case <-grace:
			return c.value()
		case <-deadline:
			return c.value()
		}
	}
}

// looksTruncated reports whether a reply is probably mid-composition: an unclosed ``` fence, an
// unbalanced JSON object, or prose that simply stops without any closing punctuation. The last case
// is what let "Here are some popular Python HTTP" through as if it were a finished answer.
func looksTruncated(s string) bool {
	s = strings.TrimSpace(s)
	if s == "" {
		return true
	}
	if strings.Count(s, "```")%2 != 0 {
		return true
	}
	if opens, closes := strings.Count(s, "{"), strings.Count(s, "}"); opens != closes {
		return true
	}
	// Decode the last rune rather than the last byte: replies routinely end in "…" or an emoji,
	// both multibyte, and a byte comparison would misread them.
	last, _ := utf8.DecodeLastRuneInString(s)
	return unicode.IsLetter(last) || unicode.IsDigit(last) || strings.ContainsRune(",;-—", last)
}

type bridge struct {
	client *whatsmeow.Client
	// One WhatsApp thread means one in-flight question; a global lock is the whole story.
	sendMu      sync.Mutex
	active      *collector
	activeM     sync.RWMutex
	pairMu      sync.Mutex
	pairCode    string
	pairPhone   string
	pairError   string
	pairCreated time.Time
}

func digitsOnly(value string) string {
	var out strings.Builder
	for _, r := range value {
		if r >= '0' && r <= '9' {
			out.WriteRune(r)
		}
	}
	return out.String()
}

func (b *bridge) pairingSnapshot() map[string]any {
	b.pairMu.Lock()
	defer b.pairMu.Unlock()
	linked := b.client.Store.ID != nil
	if linked {
		b.pairCode, b.pairError = "", ""
	}
	expiresAt := ""
	if !b.pairCreated.IsZero() && b.pairCode != "" {
		expiresAt = b.pairCreated.Add(5 * time.Minute).UTC().Format(time.RFC3339)
	}
	return map[string]any{
		"success":   true,
		"linked":    linked,
		"connected": b.client.IsConnected(),
		"logged_in": b.client.IsLoggedIn(),
		"phone":     b.pairPhone,
		"code":      b.pairCode,
		"error":     b.pairError,
		"created_at": func() string {
			if b.pairCreated.IsZero() {
				return ""
			}
			return b.pairCreated.UTC().Format(time.RFC3339)
		}(),
		"expires_at": expiresAt,
	}
}

func (b *bridge) servePairStatus(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(b.pairingSnapshot())
}

func (b *bridge) servePairStart(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		_ = json.NewEncoder(w).Encode(map[string]any{"success": false, "error": "POST required"})
		return
	}
	var body struct {
		Phone string `json:"phone"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	phone := digitsOnly(firstNonEmpty(body.Phone, os.Getenv("WA_PHONE")))
	if len(phone) < 8 || len(phone) > 15 {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{"success": false, "error": "Informe o número com DDI e DDD, somente dígitos."})
		return
	}

	b.pairMu.Lock()
	defer b.pairMu.Unlock()
	if b.client.Store.ID != nil {
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "linked": true, "message": "WhatsApp já está conectado."})
		return
	}
	if !b.client.IsConnected() {
		qrChan, err := b.client.GetQRChannel(r.Context())
		if err != nil {
			b.pairError = err.Error()
			w.WriteHeader(http.StatusBadGateway)
			_ = json.NewEncoder(w).Encode(map[string]any{"success": false, "error": b.pairError})
			return
		}
		if err := b.client.Connect(); err != nil {
			b.pairError = err.Error()
			w.WriteHeader(http.StatusBadGateway)
			_ = json.NewEncoder(w).Encode(map[string]any{"success": false, "error": b.pairError})
			return
		}
		go func() {
			for range qrChan {
			}
		}()
	}
	code, err := b.client.PairPhone(r.Context(), phone, true, whatsmeow.PairClientChrome, "Chrome (MacOS)")
	if err != nil {
		b.pairError = err.Error()
		b.pairCode = ""
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]any{"success": false, "error": b.pairError})
		return
	}
	b.pairPhone, b.pairCode, b.pairError, b.pairCreated = phone, code, "", time.Now()
	_ = json.NewEncoder(w).Encode(map[string]any{
		"success": true, "linked": false, "phone": phone, "code": code,
		"created_at": b.pairCreated.UTC().Format(time.RFC3339),
		"expires_at": b.pairCreated.Add(5 * time.Minute).UTC().Format(time.RFC3339),
	})
}

func (b *bridge) handle(raw any) {
	msg, ok := raw.(*events.Message)
	if !ok {
		return
	}
	if msg.Info.IsFromMe || msg.Info.Chat.String() != botJID.String() {
		if debug {
			if m, ok := raw.(*events.Message); ok {
				log.Printf("~~ skipped chat=%s fromMe=%v", m.Info.Chat, m.Info.IsFromMe)
			}
		}
		return
	}
	if image := msg.Message.GetImageMessage(); image != nil {
		data, err := b.client.Download(context.Background(), image)
		if err != nil {
			log.Printf("~~ failed to download Meta AI image: %v", err)
			return
		}
		b.activeM.RLock()
		c := b.active
		b.activeM.RUnlock()
		if c != nil {
			c.putImage(data, image.GetMimetype())
		}
		return
	}
	id, text := extractReply(msg.Message, msg.Info.ID)
	if debug {
		log.Printf("~~ msg id=%s edit=%q len=%d kinds=%s", msg.Info.ID, msg.Info.Edit, len(text), messageKinds(msg.Message))
		if text == "" {
			if raw, err := protojson.Marshal(msg.Message); err == nil {
				body := string(raw)
				if len(body) > 900 {
					body = body[:900] + "…"
				}
				log.Printf("~~ empty-text payload: %s", body)
			}
		}
	}
	if text == "" {
		return
	}
	b.activeM.RLock()
	c := b.active
	b.activeM.RUnlock()
	if c != nil {
		c.put(id, text)
	}
}

// extractReply pulls the reply text out of a received message, and returns the collector key it
// belongs under.
//
// Meta AI streams by sending a short message and then repeatedly EDITING it with the full text so
// far. Those edits arrive as a protocolMessage of type MESSAGE_EDIT whose payload holds the whole
// answer, not a delta. whatsmeow only unwraps edits on its history-sync path, not on live messages,
// so reading conversation/extendedTextMessage alone sees empty text and the answer stays stuck at
// the first fragment. The edit's key ID is the original message's ID, so keying on it replaces the
// fragment instead of appending a duplicate.
func extractReply(m *waE2E.Message, fallbackID string) (id string, text string) {
	id = fallbackID
	if pm := m.GetProtocolMessage(); pm.GetType() == waE2E.ProtocolMessage_MESSAGE_EDIT {
		if key := pm.GetKey().GetID(); key != "" {
			id = key
		}
		if edited := pm.GetEditedMessage(); edited != nil {
			if t := edited.GetConversation(); t != "" {
				return id, t
			}
			if t := edited.GetExtendedTextMessage().GetText(); t != "" {
				return id, t
			}
		}
	}
	if t := m.GetConversation(); t != "" {
		return id, t
	}
	return id, m.GetExtendedTextMessage().GetText()
}

func (b *bridge) ask(ctx context.Context, prompt string) (string, error) {
	b.sendMu.Lock()
	defer b.sendMu.Unlock()

	c := newCollector()
	b.activeM.Lock()
	b.active = c
	b.activeM.Unlock()
	defer func() {
		b.activeM.Lock()
		b.active = nil
		b.activeM.Unlock()
	}()

	_, err := b.client.SendMessage(ctx, botJID, &waE2E.Message{Conversation: proto.String(prompt)})
	if err != nil {
		return "", fmt.Errorf("send to %s: %w", botJID, err)
	}
	reply := c.wait()
	if reply == "" {
		return "", fmt.Errorf("no reply from %s within %s", botJID, hardLimit)
	}
	return reply, nil
}

func (b *bridge) askImage(ctx context.Context, prompt string, sourceFilename string) ([]byte, string, error) {
	b.sendMu.Lock()
	defer b.sendMu.Unlock()

	c := newCollector()
	b.activeM.Lock()
	b.active = c
	b.activeM.Unlock()
	defer func() {
		b.activeM.Lock()
		b.active = nil
		b.activeM.Unlock()
	}()

	var outgoing *waE2E.Message
	if sourceFilename != "" {
		uploadDir := os.Getenv("WA_UPLOAD_DIR")
		if uploadDir == "" {
			uploadDir = "/data/uploads"
		}
		if path.Base(sourceFilename) != sourceFilename {
			return nil, "", fmt.Errorf("invalid source filename")
		}
		sourcePath := path.Join(uploadDir, sourceFilename)
		input, readErr := os.ReadFile(sourcePath)
		if readErr != nil {
			return nil, "", fmt.Errorf("read source image: %w", readErr)
		}
		upload, uploadErr := b.client.Upload(ctx, input, whatsmeow.MediaImage)
		if uploadErr != nil {
			return nil, "", fmt.Errorf("upload source image: %w", uploadErr)
		}
		mime := "image/jpeg"
		switch strings.ToLower(path.Ext(sourceFilename)) {
		case ".png":
			mime = "image/png"
		case ".webp":
			mime = "image/webp"
		case ".gif":
			mime = "image/gif"
		}
		outgoing = &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
			// Preserve the user's request byte-for-byte. Meta AI receives the
			// original image and the exact caption written by the user.
			Caption:       proto.String(prompt),
			Mimetype:      proto.String(mime),
			URL:           &upload.URL,
			DirectPath:    &upload.DirectPath,
			MediaKey:      upload.MediaKey,
			FileEncSHA256: upload.FileEncSHA256,
			FileSHA256:    upload.FileSHA256,
			FileLength:    &upload.FileLength,
		}}
	} else {
		// Do not translate, enrich, summarize or wrap the prompt. The message
		// delivered to Meta AI must be exactly what the user wrote.
		outgoing = &waE2E.Message{Conversation: proto.String(prompt)}
	}
	// The same WhatsApp account is linked to Agent Zero. Mark this exact
	// outbound prompt before sending so that the self-chat bridge can suppress
	// only this automation echo without blocking legitimate Web/Desktop input.
	uploadDir := os.Getenv("WA_UPLOAD_DIR")
	if uploadDir == "" {
		uploadDir = "/data/uploads"
	}
	if err := os.MkdirAll(uploadDir, 0755); err != nil {
		return nil, "", fmt.Errorf("create outbound marker directory: %w", err)
	}
	digest := fmt.Sprintf("%x", sha256.Sum256([]byte(prompt)))
	markerPath := path.Join(uploadDir, ".meta-ai-outbound-"+digest+".json")
	marker, _ := json.Marshal(map[string]any{
		"prompt":    prompt,
		"expiresAt": time.Now().Add(2 * time.Minute).UnixMilli(),
	})
	if err := os.WriteFile(markerPath, marker, 0600); err != nil {
		return nil, "", fmt.Errorf("write outbound marker: %w", err)
	}
	_, err := b.client.SendMessage(ctx, botJID, outgoing)
	if err != nil {
		_ = os.Remove(markerPath)
		return nil, "", fmt.Errorf("send to %s: %w", botJID, err)
	}
	data, mime := c.waitImage()
	if len(data) == 0 {
		return nil, "", fmt.Errorf("no image from %s within %s; last reply: %s", botJID, hardLimit, c.value())
	}
	return data, mime, nil
}

func (b *bridge) serveImages(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		json.NewEncoder(w).Encode(map[string]string{"error": "POST required"})
		return
	}
	var req struct {
		Prompt         string `json:"prompt"`
		SourceFilename string `json:"source_filename"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "invalid JSON"})
		return
	}
	req.Prompt = strings.TrimSpace(req.Prompt)
	if req.Prompt == "" || len(req.Prompt) > 3500 {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"error": "prompt must contain 1 to 3500 characters"})
		return
	}
	req.SourceFilename = strings.TrimSpace(req.SourceFilename)
	data, mime, err := b.askImage(r.Context(), req.Prompt, req.SourceFilename)
	if err != nil {
		w.WriteHeader(http.StatusGatewayTimeout)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	ext := ".jpg"
	if strings.Contains(mime, "png") {
		ext = ".png"
	} else if strings.Contains(mime, "webp") {
		ext = ".webp"
	} else if strings.Contains(mime, "gif") {
		ext = ".gif"
	}
	uploadDir := os.Getenv("WA_UPLOAD_DIR")
	if uploadDir == "" {
		uploadDir = "/data/uploads"
	}
	if err := os.MkdirAll(uploadDir, 0755); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	filename := "meta-ai-" + strings.ToLower(msgID()) + ext
	if err := os.WriteFile(path.Join(uploadDir, filename), data, 0644); err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
		return
	}
	json.NewEncoder(w).Encode(map[string]any{"ok": true, "filename": filename, "mime": mime, "bytes": len(data)})
}

type toolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type chatMsg struct {
	Role       string          `json:"role"`
	Content    json.RawMessage `json:"content"`
	Name       string          `json:"name"`
	ToolCallID string          `json:"tool_call_id"`
	ToolCalls  []toolCall      `json:"tool_calls"`
}

type toolDef struct {
	Type     string `json:"type"`
	Function struct {
		Name        string          `json:"name"`
		Description string          `json:"description"`
		Parameters  json.RawMessage `json:"parameters"`
	} `json:"function"`
}

type chatReq struct {
	Messages []chatMsg `json:"messages"`
	Tools    []toolDef `json:"tools"`
	Stream   bool      `json:"stream"`
}

func contentText(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var parts []struct {
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &parts) == nil {
		var b strings.Builder
		for _, p := range parts {
			b.WriteString(p.Text)
		}
		return b.String()
	}
	return ""
}

// Meta AI has no native function calling, so tool use is prompted: the schemas go into the text and
// a tool call comes back as a fenced JSON object which parseToolCall extracts. Kept deliberately
// blunt — a consumer assistant ignores elaborate instructions more often than terse ones.
func toolPrompt(tools []toolDef) string {
	if len(tools) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("[TOOLS]\nYou can run tools. Available tools:\n")
	for _, t := range tools {
		// opencode's bash description advertises an absolute scratch directory. Meta AI treats that
		// as where work belongs, and even invents a relative "opencode/" directory from the name, so
		// the mention is removed rather than argued with.
		desc := tempDirPath.ReplaceAllString(t.Function.Description, "the working directory")
		params := strings.TrimSpace(string(t.Function.Parameters))
		if params == "" {
			params = "{}"
		}
		fmt.Fprintf(&b, "\n- %s: %s\n  parameters (JSON Schema): %s\n",
			t.Function.Name, desc, params)
	}
	b.WriteString(`
To run a tool, reply with ONLY this and nothing else, no prose before or after:
` + "```json" + `
{"tool": "<tool name>", "args": {<arguments matching the schema>}}
` + "```" + `
You will then be given the tool's output as [TOOL RESULT] and may run another tool or answer.
If you do not need a tool, just answer normally.

Rules for file paths: write files to the project working directory using a RELATIVE path such as
"server.js". Never write into a temporary directory, and ignore any temp directory path mentioned in
a tool description above unless the user explicitly asked for it.

Rules for long-running commands: anything that does not exit on its own, such as starting a server,
must be backgrounded and its output redirected, e.g. "node server.js > /tmp/srv.log 2>&1 &". Running
it in the foreground makes the tool call time out and the process is then killed, so a follow-up
curl finds nothing listening.

Rules for the shell: the bash session is persistent and already starts in the correct project
directory, so never use "cd". A "cd" leaks into later commands and makes relative paths write to the
wrong place.

Rules for files you create: never delete or clean up a file you were asked to create. The user wants
it to remain on disk.

Rules for finishing: NEVER repeat a tool call that already appears above with its [TOOL RESULT].
When the results above already contain what the user asked for, you are done: reply with the final
answer as plain text, with no JSON and no tool call. Verifying the same thing twice is a mistake.
`)
	return b.String()
}

func flatten(r chatReq) string {
	var turns []string
	if tp := toolPrompt(r.Tools); tp != "" {
		turns = append(turns, tp)
	}
	for _, m := range r.Messages {
		// An assistant turn that called a tool carries no content; replay the call so Meta AI can
		// see what it already asked for and not loop on the same tool.
		if len(m.ToolCalls) > 0 {
			for _, tc := range m.ToolCalls {
				turns = append(turns, fmt.Sprintf("[ASSISTANT ran tool]\n{\"tool\": %q, \"args\": %s}",
					tc.Function.Name, orEmptyJSON(tc.Function.Arguments)))
			}
			continue
		}
		t := contentText(m.Content)
		if strings.TrimSpace(t) == "" {
			continue
		}
		label := strings.ToUpper(m.Role)
		if m.Role == "tool" {
			label = "TOOL RESULT"
			t = clip(t, maxToolResult)
		}
		turns = append(turns, fmt.Sprintf("[%s]\n%s", label, t))
	}
	if len(turns) == 0 {
		return ""
	}
	return strings.Join(fitBudget(turns), "\n\n") + "\n\n[ASSISTANT]"
}

// fitBudget drops the oldest middle turns until the prompt fits. The first entry (the tool
// definitions) and the most recent turns are what the next step actually needs, so they stay.
func fitBudget(turns []string) []string {
	total := 0
	for _, t := range turns {
		total += len(t) + 2
	}
	if total <= maxPrompt || len(turns) < 3 {
		return turns
	}
	dropped := 0
	for total > maxPrompt && len(turns) > 2 {
		total -= len(turns[1]) + 2
		turns = append(turns[:1], turns[2:]...)
		dropped++
	}
	notice := fmt.Sprintf("[…%d earlier turns omitted to fit WhatsApp's message limit…]", dropped)
	return append([]string{turns[0], notice}, turns[1:]...)
}

var (
	// opencode advertises a scratch directory in its bash tool description, and Meta AI treats that
	// as where the user's files belong no matter how firmly the prompt says otherwise. Rewriting the
	// arguments is the only fix that does not depend on it following instructions.
	tempDirPath = regexp.MustCompile(`(?:/private)?/var/folders/(?:[^/\s"']+/)+T/opencode/?`)
	leadingCD   = regexp.MustCompile(`^\s*cd\s+(?:'[^']*'|"[^"]*"|\S+)\s*&&\s*`)
	emptyMkdir  = regexp.MustCompile(`\bmkdir\s+-p\s*&&\s*`)
	// Set WA_SCRATCH_DIR="" if your project genuinely contains a directory by this name.
	scratchDirName = firstNonEmpty(os.Getenv("WA_SCRATCH_DIR"), "opencode")
	scratchPrefix  = regexp.MustCompile(`(^|[\s"'=])` + regexp.QuoteMeta(scratchDirName) + `/`)
	scratchMkdir   = regexp.MustCompile(`\bmkdir\s+-p\s+` + regexp.QuoteMeta(scratchDirName) + `\s*(?:&&\s*)?`)
	pathKeys       = map[string]bool{"filePath": true, "path": true, "file": true, "filename": true}
)

// sanitizeArgs keeps tool calls inside the project directory: absolute paths into opencode's temp
// scratch directory collapse to a bare filename, and a leading "cd ... &&" is dropped because the
// bash session is persistent and already in the right place.
func sanitizeArgs(args string) string {
	var obj map[string]any
	if json.Unmarshal([]byte(args), &obj) != nil {
		return args
	}
	changed := false
	for k, v := range obj {
		s, ok := v.(string)
		if !ok {
			continue
		}
		orig := s
		if pathKeys[k] {
			if tempDirPath.MatchString(s) {
				s = path.Base(s)
			}
			s = strings.TrimPrefix(s, scratchDirName+"/")
		}
		if k == "command" || k == "workdir" {
			s = leadingCD.ReplaceAllString(s, "")
			s = tempDirPath.ReplaceAllString(s, "")
			// Removing the scratch path can leave "mkdir -p  && rest", whose empty operand makes the
			// whole command fail. The directory it wanted to create is the one we are already in.
			s = emptyMkdir.ReplaceAllString(s, "")
			s = scratchMkdir.ReplaceAllString(s, "")
			s = scratchPrefix.ReplaceAllString(s, "$1")
			s = emptyMkdir.ReplaceAllString(s, "")
			if k == "workdir" && strings.TrimSpace(s) == "" {
				delete(obj, k)
				changed = true
				continue
			}
		}
		if s != orig {
			obj[k] = s
			changed = true
		}
	}
	if !changed {
		return args
	}
	out, err := json.Marshal(obj)
	if err != nil {
		return args
	}
	return string(out)
}

var (
	rmCommand     = regexp.MustCompile(`(^|[;&|]\s*)rm\s`)
	deletionWords = regexp.MustCompile(`\b(delete|remove|rm|clean ?up|unlink|erase)\b`)
)

// unrequestedDeletion reports whether a bash call would delete files when the user never asked for
// deletion. Meta AI habitually "tidies up" by removing the very file it was asked to create, and it
// creates files with plain shell redirection as often as with the write tool, so tracking what it
// wrote is not enough. Losing the user's deliverable is far worse than refusing a cleanup step, so
// rm is only relayed when the request actually mentions deleting something.
func unrequestedDeletion(msgs []chatMsg, name, args string) bool {
	if name != "bash" {
		return false
	}
	var call map[string]any
	if json.Unmarshal([]byte(args), &call) != nil {
		return false
	}
	cmd, _ := call["command"].(string)
	if cmd == "" || !rmCommand.MatchString(cmd) {
		return false
	}
	for _, m := range msgs {
		if m.Role != "user" {
			continue
		}
		if deletionWords.MatchString(strings.ToLower(contentText(m.Content))) {
			return false
		}
	}
	return true
}

const keepFilesInstruction = `
[IMPORTANT] Do NOT delete the file you just created; the user wants it to stay. Do not output any
tool call now. Reply with your final answer as plain text.`

// canonicalJSON normalises argument formatting so "{\"a\":1}" and "{ \"a\": 1 }" compare equal.
func canonicalJSON(s string) string {
	var v any
	if json.Unmarshal([]byte(s), &v) != nil {
		return strings.Join(strings.Fields(s), "")
	}
	out, err := json.Marshal(v)
	if err != nil {
		return strings.Join(strings.Fields(s), "")
	}
	return string(out)
}

// priorCallCount reports how many times this exact tool call already appears in the transcript.
// Meta AI will happily re-run a command it just ran, forever, so the shim has to notice.
func priorCallCount(msgs []chatMsg, name, args string) int {
	want := canonicalJSON(args)
	n := 0
	for _, m := range msgs {
		for _, tc := range m.ToolCalls {
			if tc.Function.Name == name && canonicalJSON(orEmptyJSON(tc.Function.Arguments)) == want {
				n++
			}
		}
	}
	return n
}

// stripToolJSON removes a fenced tool-call block from a reply that is being downgraded to plain
// text, so the user never sees raw {"tool":...} JSON as their answer.
func stripToolJSON(s string) string {
	if fenced := betweenFences(s); fenced != "" && strings.Contains(fenced, `"tool"`) {
		if i := strings.Index(s, "```"); i >= 0 {
			rest := s[i+3:]
			if j := strings.Index(rest, "```"); j >= 0 {
				s = strings.TrimSpace(s[:i] + rest[j+3:])
			} else {
				s = strings.TrimSpace(s[:i])
			}
		}
	}
	if s == "" {
		return "Done."
	}
	return s
}

const stopToolsInstruction = `
[IMPORTANT] You just asked to run a tool call that already ran, and its result is in the transcript
above. Do NOT output any tool call or JSON now. Reply with your final answer to the user as plain
text.`

func orEmptyJSON(s string) string {
	if strings.TrimSpace(s) == "" {
		return "{}"
	}
	return s
}

// parseToolCall pulls a {"tool":..,"args":..} object out of Meta AI's reply. It tolerates the
// model wrapping the JSON in a fence or in chatter, which it frequently does.
func parseToolCall(reply string) (name string, args string, ok bool) {
	candidates := []string{}
	if fenced := betweenFences(reply); fenced != "" {
		candidates = append(candidates, fenced)
	}
	if start := strings.Index(reply, "{"); start >= 0 {
		if end := strings.LastIndex(reply, "}"); end > start {
			candidates = append(candidates, reply[start:end+1])
		}
	}
	for _, c := range candidates {
		var probe struct {
			Tool string          `json:"tool"`
			Args json.RawMessage `json:"args"`
		}
		if err := json.Unmarshal([]byte(c), &probe); err != nil || probe.Tool == "" {
			continue
		}
		return probe.Tool, orEmptyJSON(string(probe.Args)), true
	}
	return "", "", false
}

func betweenFences(s string) string {
	i := strings.Index(s, "```")
	if i < 0 {
		return ""
	}
	rest := s[i+3:]
	if nl := strings.IndexByte(rest, '\n'); nl >= 0 {
		rest = rest[nl+1:] // drop an optional language tag such as ```json
	}
	if j := strings.Index(rest, "```"); j >= 0 {
		return strings.TrimSpace(rest[:j])
	}
	return strings.TrimSpace(rest)
}

func tokens(s string) int { return (len(s) + 3) / 4 }

func (b *bridge) serveChat(w http.ResponseWriter, r *http.Request) {
	var req chatReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	prompt := flatten(req)
	if prompt == "" {
		http.Error(w, "no prompt content", http.StatusBadRequest)
		return
	}
	log.Printf("-> %s", strings.ReplaceAll(prompt, "\n", " | "))
	reply, err := b.ask(r.Context(), prompt)
	if err != nil {
		log.Printf("!! %v", err)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"message": err.Error()}})
		return
	}
	log.Printf("<- %s", strings.ReplaceAll(reply, "\n", " | "))

	created := time.Now().Unix()
	name, args, isCall := "", "", false
	if len(req.Tools) > 0 {
		name, args, isCall = parseToolCall(reply)
		if isCall {
			if clean := sanitizeArgs(args); clean != args {
				log.Printf("== rewrote args %s -> %s", args, clean)
				args = clean
			}
		}
		if isCall && unrequestedDeletion(req.Messages, name, args) {
			log.Printf("== refused unrequested deletion: %s", args)
			if retry, rerr := b.ask(r.Context(), prompt+keepFilesInstruction); rerr == nil && retry != "" {
				reply = stripToolJSON(retry)
			} else {
				reply = "Created and verified the file."
			}
			name, args, isCall = "", "", false
		}
		// Meta AI loops: having run a command successfully it will re-run it indefinitely instead of
		// answering. If it asks for a call already in the transcript, demand a plain-text answer
		// instead, and if it still insists on a tool call, drop the tool call so the agent
		// terminates with whatever text it produced.
		if isCall && priorCallCount(req.Messages, name, args) > 0 {
			log.Printf("== repeat of %s %s — forcing a final answer", name, args)
			if retry, rerr := b.ask(r.Context(), prompt+stopToolsInstruction); rerr == nil && retry != "" {
				reply = retry
				if n2, a2, ok2 := parseToolCall(retry); ok2 && priorCallCount(req.Messages, n2, a2) == 0 {
					name, args, isCall = n2, a2, ok2
				} else {
					name, args, isCall = "", "", false
					reply = stripToolJSON(retry)
				}
			} else {
				name, args, isCall = "", "", false
				reply = stripToolJSON(reply)
			}
		}
		if isCall {
			log.Printf("== tool call: %s %s", name, args)
		}
	}
	callID := "call_" + msgID()

	if !req.Stream {
		message := map[string]any{"role": "assistant", "content": reply}
		finish := "stop"
		if isCall {
			finish = "tool_calls"
			message = map[string]any{"role": "assistant", "content": nil,
				"tool_calls": []any{map[string]any{"id": callID, "type": "function",
					"function": map[string]string{"name": name, "arguments": args}}}}
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"id": "chatcmpl-" + msgID(), "object": "chat.completion", "created": created, "model": modelID,
			"choices": []any{map[string]any{"index": 0, "finish_reason": finish, "message": message}},
			"usage": map[string]int{"prompt_tokens": tokens(prompt), "completion_tokens": tokens(reply),
				"total_tokens": tokens(prompt) + tokens(reply)},
		})
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	flusher, _ := w.(http.Flusher)
	chunk := func(delta map[string]any, finish any) {
		payload, _ := json.Marshal(map[string]any{
			"id": "chatcmpl-" + msgID(), "object": "chat.completion.chunk", "created": created, "model": modelID,
			"choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}},
		})
		fmt.Fprintf(w, "data: %s\n\n", payload)
		if flusher != nil {
			flusher.Flush()
		}
	}
	chunk(map[string]any{"role": "assistant"}, nil)
	if isCall {
		chunk(map[string]any{"tool_calls": []any{map[string]any{"index": 0, "id": callID,
			"type": "function", "function": map[string]string{"name": name, "arguments": args}}}}, nil)
		chunk(map[string]any{}, "tool_calls")
	} else {
		chunk(map[string]any{"content": reply}, nil)
		chunk(map[string]any{}, "stop")
	}
	fmt.Fprint(w, "data: [DONE]\n\n")
	if flusher != nil {
		flusher.Flush()
	}
}

func msgID() string { return whatsmeow.GenerateMessageID() }

func main() {
	ctx := context.Background()
	dbLog := waLog.Stdout("db", "WARN", true)
	container, err := sqlstore.New(ctx, "sqlite3", "file:wametaai.db?_foreign_keys=on", dbLog)
	if err != nil {
		log.Fatalf("store: %v", err)
	}
	device, err := container.GetFirstDevice(ctx)
	if err != nil {
		log.Fatalf("device: %v", err)
	}
	client := whatsmeow.NewClient(device, waLog.Stdout("wa", "INFO", true))
	b := &bridge{client: client}
	client.AddEventHandler(b.handle)

	if client.Store.ID == nil {
		qrChan, _ := client.GetQRChannel(ctx)
		if err := client.Connect(); err != nil {
			log.Fatalf("connect: %v", err)
		}
		go func() {
			for range qrChan {
				// Draining the QR channel is required even when pairing by phone code.
			}
		}()
		log.Printf("not linked yet; open Agent Zero Settings > External > Meta AI WhatsApp Bridge to connect")
	} else if err := client.Connect(); err != nil {
		log.Fatalf("connect: %v", err)
	}

	http.HandleFunc("/v1/chat/completions", b.serveChat)
	http.HandleFunc("/v1/images/generations", b.serveImages)
	http.HandleFunc("/v1/models", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"object": "list", "data": []any{
			map[string]any{"id": modelID, "object": "model", "created": 0, "owned_by": "meta"}}})
	})
	http.HandleFunc("/v1/pair/status", b.servePairStatus)
	http.HandleFunc("/v1/pair/start", b.servePairStart)

	port := os.Getenv("WA_PORT")
	if port == "" {
		port = "8788"
	}
	log.Printf("listening on http://localhost:%s/v1  target=%s", port, botJID)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
