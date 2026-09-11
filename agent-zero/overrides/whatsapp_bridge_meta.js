#!/usr/bin/env node
/**
 * Agent Zero WhatsApp Bridge
 *
 * Standalone Node.js process that connects to WhatsApp via Baileys
 * and exposes HTTP endpoints for the Python plugin.
 *
 * Endpoints:
 *   GET  /messages       - Poll for new incoming messages
 *   POST /send           - Send a message { chatId, message, replyTo? }
 *   POST /edit           - Edit a sent message { chatId, messageId, message }
 *   POST /send-media     - Send media { chatId, filePath, mediaType?, caption?, fileName? }
 *   POST /typing         - Send typing indicator { chatId }
 *   GET  /chat/:id       - Get chat info
 *   GET  /health         - Health check
 *
 * Usage:
 *   node bridge.js --port 3100 --session /path/to/session --cache-dir /path/to/media
 */

import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } from '@whiskeysockets/baileys';
import express from 'express';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import path from 'path';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, renameSync } from 'fs';
import { randomBytes, createHash } from 'crypto';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';

// Parse CLI args
const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

const WHATSAPP_DEBUG =
  typeof process !== 'undefined' &&
  process.env &&
  typeof process.env.WHATSAPP_DEBUG === 'string' &&
  ['1', 'true', 'yes', 'on'].includes(process.env.WHATSAPP_DEBUG.toLowerCase());

const DEFAULT_DATA_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', 'tmp', 'whatsapp');
const PORT = parseInt(getArg('port', '3100'), 10);
const SESSION_DIR = getArg('session', path.join(DEFAULT_DATA_ROOT, 'session'));
const CACHE_DIR = getArg('cache-dir', path.join(DEFAULT_DATA_ROOT, 'media'));
const PAIR_ONLY = args.includes('--pair-only');
const MODE = getArg('mode', 'self-chat'); // "dedicated" or "self-chat"
// Meta AI is the only non-self chat that the image automation may contact.
// The target is intentionally server-side and cannot be overridden by callers.
const META_AI_NUMBER = String(process.env.META_AI_WHATSAPP_NUMBER || '13135550002').replace(/\D/g, '');
const META_AI_CHAT_ID = `${META_AI_NUMBER}@s.whatsapp.net`;
const META_AI_REQUEST_TTL_MS = 5 * 60 * 1000;
const SHARED_UPLOAD_DIR = String(process.env.META_AI_SHARED_UPLOAD_DIR || '/a0/usr/uploads');
const JOURNAL_TOKEN = String(process.env.WHATSAPP_JOURNAL_TOKEN || '');
const JOURNAL_GROUP_NAME = String(process.env.WHATSAPP_JOURNAL_GROUP_NAME || 'jornal-diário');
const JOURNAL_STATE_PATH = String(process.env.WHATSAPP_JOURNAL_STATE_PATH || path.join(DEFAULT_DATA_ROOT, 'journal-group.json'));


mkdirSync(SESSION_DIR, { recursive: true });
mkdirSync(CACHE_DIR, { recursive: true });
mkdirSync(path.dirname(JOURNAL_STATE_PATH), { recursive: true });

function loadJournalState() {
  try {
    const state = JSON.parse(readFileSync(JOURNAL_STATE_PATH, 'utf8'));
    return {
      groupId: String(state.groupId || ''),
      groupName: String(state.groupName || JOURNAL_GROUP_NAME),
      deliveries: state.deliveries && typeof state.deliveries === 'object' ? state.deliveries : {},
    };
  } catch {
    return { groupId: '', groupName: JOURNAL_GROUP_NAME, deliveries: {} };
  }
}

let journalState = loadJournalState();

function saveJournalState() {
  const temporary = `${JOURNAL_STATE_PATH}.tmp`;
  writeFileSync(temporary, JSON.stringify(journalState, null, 2), { mode: 0o600 });
  renameSync(temporary, JOURNAL_STATE_PATH);
}

function journalAuthorized(req) {
  const provided = String(req.get('X-Journal-Token') || '');
  if (!JOURNAL_TOKEN || !provided) return false;
  return createHash('sha256').update(provided).digest('hex') === createHash('sha256').update(JOURNAL_TOKEN).digest('hex');
}

function isLoopback(req) {
  const address = String(req.socket?.remoteAddress || '');
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function isJournalDestination(chatId) {
  return Boolean(journalState.groupId && String(chatId || '') === journalState.groupId);
}

async function ensureJournalGroup() {
  if (!sock || connectionState !== 'connected') throw new Error('Not connected to WhatsApp');
  const groups = await sock.groupFetchAllParticipating();
  const matching = Object.values(groups || {}).find(group => group?.subject === JOURNAL_GROUP_NAME);
  if (matching?.id) {
    journalState.groupId = matching.id;
    journalState.groupName = JOURNAL_GROUP_NAME;
    saveJournalState();
    groupNameCache[matching.id] = JOURNAL_GROUP_NAME;
    return matching;
  }
  let created;
  try {
    created = await sock.groupCreate(JOURNAL_GROUP_NAME, []);
  } catch (emptyError) {
    const ownJid = String(sock.user?.id || '').replace(/:\d+@/, '@');
    if (!ownJid) throw emptyError;
    created = await sock.groupCreate(JOURNAL_GROUP_NAME, [ownJid]);
  }
  if (!created?.id) throw new Error('WhatsApp não retornou o identificador do grupo criado');
  journalState.groupId = created.id;
  journalState.groupName = JOURNAL_GROUP_NAME;
  saveJournalState();
  groupNameCache[created.id] = JOURNAL_GROUP_NAME;
  return created;
}

// Build LID -> phone reverse map from session files (lid-mapping-{phone}.json)
function buildLidMap() {
  const map = {};
  try {
    for (const f of readdirSync(SESSION_DIR)) {
      const m = f.match(/^lid-mapping-(\d+)\.json$/);
      if (!m) continue;
      const phone = m[1];
      const lid = JSON.parse(readFileSync(path.join(SESSION_DIR, f), 'utf8'));
      if (lid) map[String(lid)] = phone;
    }
  } catch {}
  return map;
}
let lidToPhone = buildLidMap();

// Cache group names to avoid repeated metadata fetches
const groupNameCache = {};

// Extract raw number from a JID (strips @domain and :device)
function numOf(jid) {
  return (jid || '').split('@')[0].split(':')[0];
}

// Resolve LID-based number to phone number using lidToPhone map
function resolveNumber(num) {
  const raw = num.split(':')[0];
  return lidToPhone[raw] || lidToPhone[num] || raw;
}

const logger = pino({ level: 'warn' });

// Message queue for polling
const messageQueue = [];
const MAX_QUEUE_SIZE = 100;

// A single in-flight Meta AI request prevents replies in the shared WhatsApp
// conversation from being associated with the wrong Agent Zero chat.
const metaAiRequests = new Map();
let activeMetaAiRequestId = null;

function isMetaAiJid(jid) {
  return numOf(jid) === META_AI_NUMBER;
}

function expireMetaAiRequests() {
  const now = Date.now();
  for (const [id, request] of metaAiRequests.entries()) {
    if (now - request.createdAt <= META_AI_REQUEST_TTL_MS) continue;
    if (request.status !== 'complete') {
      request.status = 'failed';
      request.error = 'A Meta AI não respondeu com uma imagem dentro de 5 minutos.';
    }
    if (activeMetaAiRequestId === id) activeMetaAiRequestId = null;
  }
}

// Track recently sent message IDs to prevent echo-back loops
const recentlySentIds = new Set();
const MAX_RECENT_IDS = 50;

// In self-chat mode, Baileys can deliver the upsert event before sendMessage()
// resolves and gives us the outgoing message ID.  Tracking the body/media
// before sending closes that race and prevents the agent from answering itself.
const pendingOutgoing = [];
const recentInbound = new Map();
const OUTGOING_TTL_MS = 2 * 60 * 1000;
const INBOUND_DEDUP_MS = 20 * 1000;

function normalizeBody(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function purgeMessageGuards() {
  const now = Date.now();
  while (pendingOutgoing.length && pendingOutgoing[0].expiresAt <= now) pendingOutgoing.shift();
  for (const [key, expiresAt] of recentInbound.entries()) {
    if (expiresAt <= now) recentInbound.delete(key);
  }
}

function rememberOutgoing(kind, body = '') {
  purgeMessageGuards();
  pendingOutgoing.push({ kind, body: normalizeBody(body), expiresAt: Date.now() + OUTGOING_TTL_MS });
}

function consumeOutgoing(kind, body = '') {
  purgeMessageGuards();
  const normalized = normalizeBody(body);
  const index = pendingOutgoing.findIndex(item => item.kind === kind && (kind !== 'text' || item.body === normalized));
  if (index < 0) return false;
  pendingOutgoing.splice(index, 1);
  return true;
}

function isDuplicateInbound(senderNumber, body, mediaType) {
  purgeMessageGuards();
  const normalized = normalizeBody(body);
  if (!normalized && !mediaType) return false;
  const key = `${resolveNumber(senderNumber)}\u0000${mediaType || 'text'}\u0000${normalized}`;
  if (recentInbound.has(key)) return true;
  recentInbound.set(key, Date.now() + INBOUND_DEDUP_MS);
  return false;
}

function consumeMetaAiOutbound(body) {
  const exact = String(body || '');
  if (!exact) return false;
  const digest = createHash('sha256').update(exact, 'utf8').digest('hex');
  const marker = path.join(SHARED_UPLOAD_DIR, `.meta-ai-outbound-${digest}.json`);
  if (!existsSync(marker)) return false;
  try {
    const data = JSON.parse(readFileSync(marker, 'utf8'));
    unlinkSync(marker);
    return Number(data.expiresAt || 0) >= Date.now() && String(data.prompt || '') === exact;
  } catch {
    try { unlinkSync(marker); } catch {}
    return false;
  }
}

// Store received messages for reply quoting
const messageStore = new Map();
const MAX_STORED_MESSAGES = 200;

let sock = null;
let connectionState = 'disconnected';
let latestQrDataUrl = null;

async function startSocket() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['Agent Zero', 'Chrome', '120.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    getMessage: async (key) => {
      return { conversation: '' };
    },
  });

  sock.ev.on('creds.update', () => { saveCreds(); lidToPhone = buildLidMap(); });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n[bridge] Scan this QR code with WhatsApp on your phone:\n');
      qrcode.generate(qr, { small: true });
      console.log('\n[bridge] Waiting for scan...\n');
      QRCode.toDataURL(qr, { width: 256, margin: 2 }).then(url => {
        latestQrDataUrl = url;
      }).catch(() => {});
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      connectionState = 'disconnected';

      if (reason === DisconnectReason.loggedOut) {
        console.log('[bridge] Logged out. Delete session and restart to re-authenticate.');
        process.exit(1);
      } else {
        if (reason === 515) {
          console.log('[bridge] WhatsApp requested restart (code 515). Reconnecting...');
        } else {
          console.log(`[bridge] Connection closed (reason: ${reason}). Reconnecting in 3s...`);
        }
        setTimeout(startSocket, reason === 515 ? 1000 : 3000);
      }
    } else if (connection === 'open') {
      connectionState = 'connected';
      latestQrDataUrl = null;
      console.log('[bridge] WhatsApp connected');
      if (PAIR_ONLY) {
        console.log('[bridge] Pairing complete. Credentials saved.');
        setTimeout(() => process.exit(0), 2000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;

    for (const msg of messages) {
      if (!msg.message) continue;

      const chatId = msg.key.remoteJid;
      if (WHATSAPP_DEBUG) {
        try {
          console.log(JSON.stringify({
            event: 'upsert', type,
            fromMe: !!msg.key.fromMe, chatId,
            senderId: msg.key.participant || chatId,
            messageKeys: Object.keys(msg.message || {}),
          }));
        } catch {}
      }
      const senderId = msg.key.participant || chatId;
      const isGroup = chatId.endsWith('@g.us');
      const senderNumber = senderId.replace(/@.*/, '');

      // The Meta AI linked session writes an exact, short-lived marker before
      // sending its prompt. Consume only that marked echo. This preserves
      // legitimate messages from WhatsApp Web/Desktop, which also use 3EB0 IDs.
      if (!isGroup && MODE === 'self-chat' && consumeMetaAiOutbound(
        msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || ''
      )) {
        if (WHATSAPP_DEBUG) {
          try { console.log(JSON.stringify({ event: 'ignored', reason: 'meta_ai_outbound_marker', chatId, messageId: msg.key.id })); } catch {}
        }
        continue;
      }

      // Handle fromMe messages based on mode
      if (msg.key.fromMe) {
        if (isGroup || chatId.includes('status')) continue;

        if (MODE === 'dedicated') {
          // Dedicated mode: separate number — all fromMe are echo-backs, skip
          continue;
        }

        // Self-chat mode: only accept messages in the user's own self-chat
        const myNumber = (sock.user?.id || '').replace(/:.*@/, '@').replace(/@.*/, '');
        const myLid = (sock.user?.lid || '').replace(/:.*@/, '@').replace(/@.*/, '');
        const chatNumber = chatId.replace(/@.*/, '');
        const isSelfChat = (myNumber && chatNumber === myNumber) || (myLid && chatNumber === myLid);
        if (!isSelfChat) continue;
      }

      // Skip status broadcasts
      if (chatId === 'status@broadcast') continue;

      // Unwrap documentWithCaptionMessage (Baileys wraps captioned docs)
      if (msg.message.documentWithCaptionMessage?.message?.documentMessage) {
        msg.message.documentMessage = msg.message.documentWithCaptionMessage.message.documentMessage;
      }

      // Extract message body
      let body = '';
      let hasMedia = false;
      let mediaType = '';
      const mediaUrls = [];

      if (msg.message.conversation) {
        body = msg.message.conversation;
      } else if (msg.message.extendedTextMessage?.text) {
        body = msg.message.extendedTextMessage.text;
      } else if (msg.message.imageMessage) {
        body = msg.message.imageMessage.caption || '';
        hasMedia = true;
        mediaType = 'image';
      } else if (msg.message.videoMessage) {
        body = msg.message.videoMessage.caption || '';
        hasMedia = true;
        mediaType = 'video';
      } else if (msg.message.audioMessage || msg.message.pttMessage) {
        hasMedia = true;
        mediaType = msg.message.pttMessage ? 'ptt' : 'audio';
      } else if (msg.message.documentMessage) {
        body = msg.message.documentMessage.caption || '';
        hasMedia = true;
        mediaType = 'document';
      }

      // Fail closed for bridge-originated messages. ID matching remains useful
      // after sendMessage resolves, while the pre-send body/media guard covers
      // the upsert-before-promise race seen in self-chat mode.
      if (msg.key.fromMe) {
        const automatedStatus = /^(?:Queued message #\d+\.|Hello! 👋, I'm Agent Zero, your AI assistant\.)/i.test(normalizeBody(body));
        const outgoingKind = hasMedia ? 'media' : 'text';
        if (recentlySentIds.has(msg.key.id) || automatedStatus || consumeOutgoing(outgoingKind, body)) {
          if (WHATSAPP_DEBUG) {
            try { console.log(JSON.stringify({ event: 'ignored', reason: 'self_chat_outgoing', chatId, messageId: msg.key.id })); } catch {}
          }
          continue;
        }
      }

      // Download media to disk
      if (hasMedia) {
        try {
          const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
          let ext = '.bin';
          let prefix = mediaType;
          if (mediaType === 'image') {
            const mime = msg.message.imageMessage?.mimetype || 'image/jpeg';
            const extMap = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
            ext = extMap[mime] || '.jpg';
          } else if (mediaType === 'video') {
            const mime = msg.message.videoMessage?.mimetype || 'video/mp4';
            ext = mime.includes('mp4') ? '.mp4' : '.mkv';
          } else if (mediaType === 'audio' || mediaType === 'ptt') {
            const mime = msg.message.audioMessage?.mimetype || msg.message.pttMessage?.mimetype || 'audio/ogg';
            ext = mime.includes('opus') || mime.includes('ogg') ? '.ogg' : '.mp3';
          } else if (mediaType === 'document') {
            const docMsg = msg.message.documentMessage;
            const fileName = docMsg?.fileName || '';
            if (fileName) {
              // Use original filename for documents
              const filePath = path.join(CACHE_DIR, `${randomBytes(4).toString('hex')}_${fileName}`);
              writeFileSync(filePath, buf);
              mediaUrls.push(filePath);
              if (!body) body = fileName;
            } else {
              const mime = docMsg?.mimetype || 'application/octet-stream';
              const docExtMap = { 'application/pdf': '.pdf', 'application/msword': '.doc' };
              ext = docExtMap[mime] || '.bin';
            }
          }
          // Write file if not already handled (document with fileName)
          if (mediaUrls.length === 0) {
            const filePath = path.join(CACHE_DIR, `${prefix}_${randomBytes(6).toString('hex')}${ext}`);
            writeFileSync(filePath, buf);
            mediaUrls.push(filePath);
          }
        } catch (err) {
          console.error(`[bridge] Failed to download ${mediaType}:`, err.message);
        }
      }

      // For media without caption, use a placeholder
      if (hasMedia && !body) {
        body = `[${mediaType} received]`;
      }

      // Capture Meta AI replies in an isolated queue. They must never enter the
      // normal WhatsApp bot queue, which is restricted to the owner's self-chat.
      if (!msg.key.fromMe && (isMetaAiJid(chatId) || isMetaAiJid(senderId))) {
        expireMetaAiRequests();
        const request = activeMetaAiRequestId && metaAiRequests.get(activeMetaAiRequestId);
        if (request && Number(msg.messageTimestamp || 0) * 1000 >= request.sentAt - 2000) {
          request.lastText = body || request.lastText || '';
          request.updatedAt = Date.now();
          if (mediaType === 'image' && mediaUrls.length > 0) {
            request.status = 'complete';
            request.mediaUrls = mediaUrls;
            activeMetaAiRequestId = null;
            console.log(`[bridge] Meta AI image received for request ${request.id}`);
          }
        }
        continue;
      }

      // Skip echo-backs via recently sent IDs
      if (recentlySentIds.has(msg.key.id)) {
        if (WHATSAPP_DEBUG) {
          try { console.log(JSON.stringify({ event: 'ignored', reason: 'agent_echo', chatId, messageId: msg.key.id })); } catch {}
        }
        continue;
      }

      // Skip empty messages
      if (!body && !hasMedia) {
        if (WHATSAPP_DEBUG) {
          try {
            console.log(JSON.stringify({ event: 'ignored', reason: 'empty', chatId, messageKeys: Object.keys(msg.message || {}) }));
          } catch {}
        }
        continue;
      }

      // Detect if the bot was mentioned or replied to in a group message
      let mentionedMe = false;
      let repliedToMe = false;
      if (isGroup && sock.user) {
        const contextInfo = msg.message.extendedTextMessage?.contextInfo
          || msg.message.imageMessage?.contextInfo
          || msg.message.videoMessage?.contextInfo
          || msg.message.documentMessage?.contextInfo
          || null;

        // Build set of bot's own numbers for comparison
        const myNums = new Set();
        if (sock.user.id) myNums.add(numOf(sock.user.id));
        if (sock.user.lid) myNums.add(numOf(sock.user.lid));
        for (const [lid, phone] of Object.entries(lidToPhone)) {
          if (myNums.has(lid)) myNums.add(String(phone));
          if (myNums.has(String(phone))) myNums.add(lid);
        }

        // Check @mentions
        const mentionedJids = contextInfo?.mentionedJid || [];
        for (const jid of mentionedJids) {
          if (myNums.has(numOf(jid))) { mentionedMe = true; break; }
        }

        // Check if replying to a bot message
        if (contextInfo?.stanzaId) {
          const replyParticipant = contextInfo.participant || '';
          if (replyParticipant && myNums.has(numOf(replyParticipant))) {
            repliedToMe = true;
          } else if (recentlySentIds.has(contextInfo.stanzaId)) {
            repliedToMe = true;
          }
        }

        if (WHATSAPP_DEBUG && (mentionedJids.length > 0 || repliedToMe)) {
          try { console.log(JSON.stringify({ event: 'mention_reply_check', myNums: [...myNums], mentionedJids, mentionedMe, repliedToMe, stanzaId: contextInfo?.stanzaId })); } catch {}
        }
      }

      // Resolve sender number (LID -> phone if possible)
      const resolvedSender = resolveNumber(senderNumber);

      // Resolve group name from metadata cache or fetch
      let chatName;
      if (isGroup) {
        if (groupNameCache[chatId]) {
          chatName = groupNameCache[chatId];
        } else {
          try {
            const meta = await sock.groupMetadata(chatId);
            chatName = meta.subject || chatId.split('@')[0];
            groupNameCache[chatId] = chatName;
          } catch {
            chatName = chatId.split('@')[0];
          }
        }
      } else {
        chatName = msg.pushName || resolvedSender;
      }

      // Strip bot's own @mention from body so agent gets clean text
      let cleanBody = body;
      if (isGroup && mentionedMe && sock.user) {
        const myNum = numOf(sock.user.id || '');
        const myLidNum = numOf(sock.user.lid || '');
        // Remove @number or @lid patterns matching the bot
        for (const n of [myNum, myLidNum, resolveNumber(myNum), resolveNumber(myLidNum)]) {
          if (n) cleanBody = cleanBody.replace(new RegExp(`@${n}\\b`, 'g'), '').trim();
        }
      }

      // WhatsApp may report the same self-chat message once through the LID and
      // once through the legacy phone JID. Treat that pair as one request.
      if (!isGroup && isDuplicateInbound(resolvedSender, cleanBody, mediaType)) {
        if (WHATSAPP_DEBUG) {
          try { console.log(JSON.stringify({ event: 'ignored', reason: 'duplicate_self_chat', chatId, messageId: msg.key.id })); } catch {}
        }
        continue;
      }

      const event = {
        messageId: msg.key.id,
        chatId,
        senderId,
        senderNumber: resolvedSender,
        senderName: msg.pushName || resolvedSender,
        chatName,
        isGroup,
        mentionedMe,
        repliedToMe,
        body: cleanBody,
        hasMedia,
        mediaType,
        mediaUrls,
        timestamp: msg.messageTimestamp,
      };

      // Store raw message for reply quoting
      messageStore.set(msg.key.id, msg);
      if (messageStore.size > MAX_STORED_MESSAGES) {
        messageStore.delete(messageStore.keys().next().value);
      }

      messageQueue.push(event);
      if (messageQueue.length > MAX_QUEUE_SIZE) {
        messageQueue.shift();
      }
    }
  });
}

// HTTP server
const app = express();
app.use(express.json({ limit: '80mb' }));

// Non-journal bridge endpoints are private to the Agent Zero process. The only
// remotely callable operations are the token-protected journal endpoints.
app.use((req, res, next) => {
  if (isLoopback(req) || req.path.startsWith('/journal/')) return next();
  return res.status(403).json({ error: 'Bridge endpoint is local-only' });
});

app.post('/journal/group/ensure', async (req, res) => {
  if (!journalAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const group = await ensureJournalGroup();
    return res.json({ ok: true, groupId: group.id, name: JOURNAL_GROUP_NAME });
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
});

app.get('/journal/health', async (req, res) => {
  if (!journalAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  return res.json({
    status: connectionState,
    configured: Boolean(journalState.groupId),
    groupId: journalState.groupId || null,
    name: JOURNAL_GROUP_NAME,
  });
});

app.post('/journal/publish', async (req, res) => {
  if (!journalAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (!sock || connectionState !== 'connected') return res.status(503).json({ error: 'Not connected to WhatsApp' });
  const deliveryId = String(req.body?.deliveryId || '').trim();
  const imageBase64 = String(req.body?.imageBase64 || '');
  const imageMime = String(req.body?.imageMime || 'image/jpeg');
  const text = String(req.body?.text || '');
  const audioBase64 = String(req.body?.audioBase64 || '');
  const audioMime = String(req.body?.audioMime || 'audio/mpeg');
  if (!/^[a-zA-Z0-9._:-]{3,180}$/.test(deliveryId)) return res.status(400).json({ error: 'Invalid deliveryId' });
  if (!imageBase64 || !text || !audioBase64) return res.status(400).json({ error: 'Image, text and audio are required' });
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(imageMime)) return res.status(400).json({ error: 'Unsupported image type' });
  if (!['audio/mpeg', 'audio/ogg', 'audio/mp4'].includes(audioMime)) return res.status(400).json({ error: 'Unsupported audio type' });
  if (text.length > 60000) return res.status(400).json({ error: 'Journal text is too long' });
  try {
    const group = await ensureJournalGroup();
    const progress = journalState.deliveries[deliveryId] || { image: false, text: false, audio: false };
    if (!progress.image) {
      rememberOutgoing('media');
      const sent = await sock.sendMessage(group.id, { image: Buffer.from(imageBase64, 'base64'), mimetype: imageMime });
      if (sent?.key?.id) recentlySentIds.add(sent.key.id);
      progress.image = true;
      journalState.deliveries[deliveryId] = progress;
      saveJournalState();
    }
    if (!progress.text) {
      rememberOutgoing('text', text);
      const sent = await sock.sendMessage(group.id, { text });
      if (sent?.key?.id) recentlySentIds.add(sent.key.id);
      progress.text = true;
      saveJournalState();
    }
    if (!progress.audio) {
      rememberOutgoing('media');
      const sent = await sock.sendMessage(group.id, { audio: Buffer.from(audioBase64, 'base64'), mimetype: audioMime, ptt: false });
      if (sent?.key?.id) recentlySentIds.add(sent.key.id);
      progress.audio = true;
      saveJournalState();
    }
    const completedIds = Object.entries(journalState.deliveries).filter(([, value]) => value?.audio).map(([key]) => key);
    for (const oldId of completedIds.slice(0, Math.max(0, completedIds.length - 200))) delete journalState.deliveries[oldId];
    saveJournalState();
    return res.json({ ok: true, deliveryId, complete: true, order: ['image', 'text', 'audio'] });
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err), deliveryId });
  }
});

// Poll for new messages
app.get('/messages', (req, res) => {
  const msgs = messageQueue.splice(0, messageQueue.length);
  res.json(msgs);
});

// Start a deterministic image-generation request in the official Meta AI chat.
// No chatId is accepted from the caller, so this endpoint cannot message other
// WhatsApp contacts.
app.post('/meta-ai/generate', async (req, res) => {
  if (!sock || connectionState !== 'connected') {
    return res.status(503).json({ error: 'Not connected to WhatsApp' });
  }
  expireMetaAiRequests();
  const requestId = String(req.body?.requestId || '').trim();
  const prompt = String(req.body?.prompt || '').trim();
  if (!/^[a-f0-9-]{16,64}$/i.test(requestId)) {
    return res.status(400).json({ error: 'Invalid requestId' });
  }
  if (!prompt || prompt.length > 3500) {
    return res.status(400).json({ error: 'Prompt must contain 1 to 3500 characters' });
  }
  if (activeMetaAiRequestId) {
    return res.status(409).json({ error: 'Another Meta AI image request is still running' });
  }
  try {
    const outbound = prompt;
    const request = {
      id: requestId,
      prompt,
      status: 'sending',
      createdAt: Date.now(),
      sentAt: Date.now(),
      updatedAt: Date.now(),
      mediaUrls: [],
      lastText: '',
      error: '',
    };
    metaAiRequests.set(requestId, request);
    activeMetaAiRequestId = requestId;
    rememberOutgoing('text', outbound);
    const sent = await sock.sendMessage(META_AI_CHAT_ID, { text: outbound });
    request.sentAt = Date.now();
    request.updatedAt = Date.now();
    request.status = 'waiting';
    if (sent?.key?.id) {
      recentlySentIds.add(sent.key.id);
      if (recentlySentIds.size > MAX_RECENT_IDS) {
        recentlySentIds.delete(recentlySentIds.values().next().value);
      }
    }
    return res.json({ ok: true, requestId, status: request.status });
  } catch (err) {
    activeMetaAiRequestId = null;
    const request = metaAiRequests.get(requestId);
    if (request) {
      request.status = 'failed';
      request.error = err.message || String(err);
      request.updatedAt = Date.now();
    }
    return res.status(500).json({ error: err.message || String(err) });
  }
});

app.get('/meta-ai/result/:requestId', (req, res) => {
  expireMetaAiRequests();
  const request = metaAiRequests.get(String(req.params.requestId || ''));
  if (!request) return res.status(404).json({ error: 'Request not found' });
  const result = {
    requestId: request.id,
    status: request.status,
    mediaUrls: request.mediaUrls || [],
    lastText: request.lastText || '',
    error: request.error || '',
    updatedAt: request.updatedAt,
  };
  if (req.query.consume === '1' && ['complete', 'failed'].includes(request.status)) {
    metaAiRequests.delete(request.id);
  }
  res.json(result);
});

// Send a message
app.post('/send', async (req, res) => {
  if (!sock || connectionState !== 'connected') {
    return res.status(503).json({ error: 'Not connected to WhatsApp' });
  }

  const { chatId, message, replyTo } = req.body;
  if (!chatId || !message) {
    return res.status(400).json({ error: 'chatId and message are required' });
  }
  if (isJournalDestination(chatId)) return res.status(403).json({ error: 'Journal group accepts only journal publications' });

  try {
    const opts = {};
    if (replyTo && messageStore.has(replyTo)) {
      opts.quoted = messageStore.get(replyTo);
    }
    rememberOutgoing('text', message);
    const sent = await sock.sendMessage(chatId, { text: message }, opts);

    if (sent?.key?.id) {
      recentlySentIds.add(sent.key.id);
      if (recentlySentIds.size > MAX_RECENT_IDS) {
        recentlySentIds.delete(recentlySentIds.values().next().value);
      }
    }

    res.json({ success: true, messageId: sent?.key?.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Edit a previously sent message
app.post('/edit', async (req, res) => {
  if (!sock || connectionState !== 'connected') {
    return res.status(503).json({ error: 'Not connected to WhatsApp' });
  }

  const { chatId, messageId, message } = req.body;
  if (!chatId || !messageId || !message) {
    return res.status(400).json({ error: 'chatId, messageId, and message are required' });
  }
  if (isJournalDestination(chatId)) return res.status(403).json({ error: 'Journal group messages cannot be edited by general tools' });

  try {
    const key = { id: messageId, fromMe: true, remoteJid: chatId };
    rememberOutgoing('text', message);
    await sock.sendMessage(chatId, { text: message, edit: key });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// MIME type map and media type inference
const MIME_MAP = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo',
  mkv: 'video/x-matroska', '3gp': 'video/3gpp',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function inferMediaType(ext) {
  if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'avi', 'mkv', '3gp'].includes(ext)) return 'video';
  if (['ogg', 'opus', 'mp3', 'wav', 'm4a'].includes(ext)) return 'audio';
  return 'document';
}

// Send media natively
app.post('/send-media', async (req, res) => {
  if (!sock || connectionState !== 'connected') {
    return res.status(503).json({ error: 'Not connected to WhatsApp' });
  }

  const { chatId, filePath, mediaType, caption, fileName } = req.body;
  if (!chatId || !filePath) {
    return res.status(400).json({ error: 'chatId and filePath are required' });
  }
  if (isJournalDestination(chatId)) return res.status(403).json({ error: 'Journal group accepts only journal publications' });

  try {
    if (!existsSync(filePath)) {
      return res.status(404).json({ error: `File not found: ${filePath}` });
    }

    const buffer = readFileSync(filePath);
    const ext = filePath.toLowerCase().split('.').pop();
    const type = mediaType || inferMediaType(ext);
    let msgPayload;

    switch (type) {
      case 'image':
        msgPayload = { image: buffer, caption: caption || undefined, mimetype: MIME_MAP[ext] || 'image/jpeg' };
        break;
      case 'video':
        msgPayload = { video: buffer, caption: caption || undefined, mimetype: MIME_MAP[ext] || 'video/mp4' };
        break;
      case 'audio': {
        const audioMime = (ext === 'ogg' || ext === 'opus') ? 'audio/ogg; codecs=opus' : 'audio/mpeg';
        msgPayload = { audio: buffer, mimetype: audioMime, ptt: ext === 'ogg' || ext === 'opus' };
        break;
      }
      case 'document':
      default:
        msgPayload = {
          document: buffer,
          fileName: fileName || path.basename(filePath),
          caption: caption || undefined,
          mimetype: MIME_MAP[ext] || 'application/octet-stream',
        };
        break;
    }

    rememberOutgoing('media');
    const sent = await sock.sendMessage(chatId, msgPayload);

    if (sent?.key?.id) {
      recentlySentIds.add(sent.key.id);
      if (recentlySentIds.size > MAX_RECENT_IDS) {
        recentlySentIds.delete(recentlySentIds.values().next().value);
      }
    }

    res.json({ success: true, messageId: sent?.key?.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Typing indicator
app.post('/typing', async (req, res) => {
  if (!sock || connectionState !== 'connected') {
    return res.status(503).json({ error: 'Not connected' });
  }

  const { chatId, status } = req.body;
  if (!chatId) return res.status(400).json({ error: 'chatId required' });

  try {
    await sock.sendPresenceUpdate(status === 'paused' ? 'paused' : 'composing', chatId);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false });
  }
});

// Chat info
app.get('/chat/:id', async (req, res) => {
  const chatId = req.params.id;
  const isGroup = chatId.endsWith('@g.us');

  if (isGroup && sock) {
    try {
      const metadata = await sock.groupMetadata(chatId);
      return res.json({
        name: metadata.subject,
        isGroup: true,
        participants: metadata.participants.map(p => p.id),
      });
    } catch {
      // Fall through to default
    }
  }

  res.json({
    name: chatId.replace(/@.*/, ''),
    isGroup,
    participants: [],
  });
});

// QR code for web UI pairing
app.get('/qr', (req, res) => {
  if (connectionState === 'connected') {
    return res.json({ status: 'connected', qr: null });
  }
  if (latestQrDataUrl) {
    return res.json({ status: 'waiting_scan', qr: latestQrDataUrl });
  }
  res.json({ status: 'waiting_qr', qr: null });
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: connectionState,
    queueLength: messageQueue.length,
    metaAi: {
      target: META_AI_NUMBER,
      active: activeMetaAiRequestId,
      pending: [...metaAiRequests.values()].filter(item => item.status === 'waiting').length,
    },
    uptime: process.uptime(),
  });
});

// Start
if (PAIR_ONLY) {
  console.log('[bridge] WhatsApp pairing mode');
  console.log(`[bridge] Session: ${SESSION_DIR}`);
  console.log();
  startSocket();
} else {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[bridge] WhatsApp bridge listening on port ${PORT} (mode: ${MODE})`);
    console.log(`[bridge] Session: ${SESSION_DIR}`);
    console.log();
    startSocket();
  });
}
