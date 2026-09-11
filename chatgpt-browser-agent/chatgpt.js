#!/usr/bin/env node
/**
 * chatgpt.js — Fast persistent-browser Codex-style CLI backed by chatgpt.com
 *
 * The browser runs as a background daemon so the launch/navigation overhead
 * only happens once. Subsequent calls take ~2-5s (ChatGPT response time only).
 *
 * Setup (first time):
 *   node chatgpt.js --login
 *
 * Usage:
 *   node chatgpt.js "prompt"                              # continue last chat
 *   node chatgpt.js --new "prompt"                        # start fresh chat
 *   node chatgpt.js --code "write fizzbuzz in Go"         # extract code only
 *   node chatgpt.js --file <path> "prompt"                # attach a file
 *   node chatgpt.js --git "write a commit message"        # attach git context
 *   node chatgpt.js --context "we use Fiber v2" "prompt"  # inline context
 *   cat error.log | node chatgpt.js "what is wrong"       # pipe input
 *   node chatgpt.js --status                              # check daemon
 *   node chatgpt.js --stop                                # kill daemon
 */

const { addExtra }        = require('puppeteer-extra');
const puppeteerCore       = require('puppeteer-core');
const StealthPlugin       = require('puppeteer-extra-plugin-stealth');
const path                = require('path');
const os                  = require('os');
const fs                  = require('fs');
const http                = require('http');
const readline            = require('readline');
const { execSync, spawn } = require('child_process');

const puppeteer = addExtra(puppeteerCore);
puppeteer.use(StealthPlugin());

// ─── Constants ────────────────────────────────────────────────────────────────

const CHROME_PATH      = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const STATE_DIR        = process.env.CHATGPT_BROWSER_STATE_DIR || os.homedir();
const PROFILE_DIR      = path.join(STATE_DIR, '.chatgpt-poc-profile');
const SESSION_FILE     = path.join(STATE_DIR, '.chatgpt-poc-session');
const DAEMON_FILE      = path.join(STATE_DIR, '.chatgpt-poc-daemon.json');
const DAEMON_LOG       = path.join(STATE_DIR, '.chatgpt-poc-daemon.log');
const MANUAL_LOGIN_FILE = path.join(STATE_DIR, '.manual-login-active');
const CHATGPT_URL      = 'https://chatgpt.com';
// One Agent Zero turn gets a bounded 130-second browser budget. ChatGPT must
// begin answering within 60 seconds; otherwise the daemon reloads once and
// makes one final attempt inside the same overall budget.
const REQUEST_TIMEOUT        = 130_000;
const RESPONSE_START_TIMEOUT = 60_000;

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `\
You are a senior software engineer acting as a coding assistant.
Rules:
- Be concise. Code over explanation.
- Write complete, working, production-quality code.
- Match the language, style, and patterns of any provided code or context.
- When fixing code show only the corrected version, no before/after commentary.
- No disclaimers, caveats, or filler text.
- If the task is ambiguous, pick the most reasonable interpretation and go.
---
`;

// ─── Prompt builders ──────────────────────────────────────────────────────────

function readStdin() {
  return new Promise(resolve => {
    if (process.stdin.isTTY) return resolve(null);
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => (data += chunk));
    process.stdin.on('end', () => resolve(data.trim() || null));
  });
}

function readFile(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
  return fs.readFileSync(abs, 'utf8');
}

function getGitContext(cwd) {
  const run = cmd => { try { return execSync(cmd, { encoding: 'utf8', cwd }).trim(); } catch { return ''; } };
  const branch = run('git branch --show-current');
  const status = run('git status --short');
  const diff   = run('git diff HEAD');
  if (!branch && !status && !diff) throw new Error('Not inside a git repo or no changes found.');
  let out = '';
  if (branch) out += `Branch: ${branch}\n`;
  if (status) out += `\nStatus:\n${status}\n`;
  if (diff)   out += `\nDiff:\n${diff}\n`;
  return out;
}

function extractCodeBlocks(text) {
  const blocks = [];
  const re = /```[\w]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) blocks.push(m[1].trimEnd());
  return blocks.length > 0 ? blocks.join('\n\n') : text;
}

function buildFullPrompt({ userPrompt, stdinData, fileData, gitData, contextData }) {
  const parts = [SYSTEM_PROMPT];
  if (contextData) parts.push(`Context:\n${contextData}\n`);
  if (gitData)     parts.push(`Git context:\n${gitData}\n`);
  if (fileData)    parts.push(`File content:\n\`\`\`\n${fileData}\n\`\`\`\n`);
  if (stdinData)   parts.push(`Input:\n\`\`\`\n${stdinData}\n\`\`\`\n`);
  parts.push(`Task: ${userPrompt}`);
  return parts.join('\n');
}

// ─── Browser helpers (daemon-side only) ───────────────────────────────────────

/**
 * Upload a local file to ChatGPT via direct CDP file-input injection.
 *
 * The ChatGPT composer always has a hidden <input id="upload-files"> in the DOM.
 * Puppeteer's uploadFile() uses the Chrome DevTools Protocol to set files on
 * the input element without needing a native file-picker dialog (which requires
 * a real user gesture and cannot be triggered programmatically in headless mode).
 * After setting the files via CDP we fire a synthetic change event so React's
 * event system picks up the new FileList and registers the attachment.
 */
async function uploadFileToChatGPT(page, uploadPath, log) {
  const abs = path.resolve(uploadPath);
  if (!fs.existsSync(abs)) throw new Error(`Upload file not found: ${abs}`);
  log(`Uploading file: ${abs}`);

  await page.bringToFront();

  const plus = await page.$('[data-testid="composer-plus-btn"]');
  if (plus) {
    await plus.click();
    await new Promise(r => setTimeout(r, 350));
    const status = await page.evaluate(() => document.body.innerText);
    await page.keyboard.press('Escape');
    const wait = status.match(/wait\s+(\d+)\s+minutes?\s+to upload again/i);
    if (wait) throw new Error(`UPLOAD_RATE_LIMIT retry_after_seconds=${Number(wait[1])*60}; provider upload quota exhausted`);
    if (/Get Plus for more uploads/i.test(status)) throw new Error('UPLOAD_RATE_LIMIT retry_after_seconds=1800; provider upload quota exhausted');
  }

  // Wait for the hidden file input to be present in the DOM
  const inputHandle = await page.waitForSelector('#upload-files', { timeout: 8_000 });

  // CDP-level file injection — no dialog needed
  await inputHandle.uploadFile(abs);

  // uploadFile already dispatches input/change. A second change can clear it.

  // Give ChatGPT's React handler a moment to process the file and render a preview
  await new Promise(r => setTimeout(r, 2_000));

  // ChatGPT may show a "You've already uploaded this file" warning dialog when
  // the same file has been uploaded recently.  Dismiss it so the flow continues.
  await page.waitForFunction(name => document.body.innerText.includes(name),
    {timeout:60000}, path.basename(abs));

  log('Upload complete.');
}

function launchBrowser() {
  return puppeteer.launch({
    executablePath: CHROME_PATH,
    userDataDir: PROFILE_DIR,
    headless: false,
    // Google rejects sign-in when Puppeteer's default automation marker is
    // present. Keep the normal browser arguments, but remove that marker and
    // use the DevTools pipe instead of exposing a debugging port.
    ignoreDefaultArgs: ['--enable-automation'],
    pipe: true,
    args: [
      ...(process.env.CHROME_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
    ],
    defaultViewport: null,
  });
}

// Single DOM operation — no keystroke simulation, no chunking, no delay.
// execCommand('insertText') is the fastest reliable way to fill a
// React-controlled contenteditable without breaking its event listeners.
async function dismissBlockingOverlays(page, log) {
  for (let pass=0; pass<4; pass++) {
    const action=await page.evaluate(() => {
      const visible=el=>{
        const r=el.getBoundingClientRect();
        const s=getComputedStyle(el);
        return r.width>0 && r.height>0 && s.visibility!=='hidden' && s.display!=='none';
      };
      const composer=document.querySelector('#prompt-textarea');
      const send=document.querySelector('button[data-testid="send-button"]');
      const candidates=[...document.querySelectorAll('[role="dialog"], dialog, [aria-modal="true"], [data-state="open"]')]
        .filter(visible)
        // ChatGPT marks its ordinary navigation sidebar as a dialog. It does
        // not cover the composer and must never be mistaken for a popup.
        .filter(el=>!el.querySelector('[data-testid="close-sidebar-button"]'));
      const labels=/^(close|dismiss|not now|maybe later|continue|got it|okay|ok|fechar|dispensar|agora não|talvez depois|continuar|entendi)$/i;
      for (const modal of candidates) {
        const button=[...modal.querySelectorAll('button')].find(b=>visible(b) && labels.test((b.getAttribute('aria-label')||b.innerText||b.title||'').trim()));
        if(button) { button.click(); return {kind:'button',label:(button.getAttribute('aria-label')||button.innerText||button.title||'').trim()}; }
      }
      if(send && visible(send)) {
        const r=send.getBoundingClientRect();
        const top=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
        if(top && !send.contains(top)) return {kind:'blocked',tag:top.tagName,text:(top.innerText||top.getAttribute?.('aria-label')||'').trim().slice(0,120)};
      }
      return {kind:'clear',composer:!!composer};
    });
    if(action.kind==='clear') return;
    if(action.kind==='button') {
      log(`Dismissed blocking popup control: ${action.label}`);
      await new Promise(r=>setTimeout(r,350));
      continue;
    }
    // Escape is a safe fallback for a transient popover intercepting the send
    // control. It does not submit or modify composer text.
    log(`Composer obstructed by ${action.tag}: ${action.text || 'unnamed overlay'}; dismissing with Escape`);
    await page.keyboard.press('Escape');
    await new Promise(r=>setTimeout(r,350));
  }
  const blocked=await page.evaluate(()=>{
    const send=document.querySelector('button[data-testid="send-button"]');
    if(!send) return 'send button missing';
    const r=send.getBoundingClientRect(); const top=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
    return top && !send.contains(top) ? `${top.tagName}: ${(top.innerText||'').trim().slice(0,120)}` : '';
  });
  if(blocked) throw new Error(`A popup is still blocking the ChatGPT composer (${blocked})`);
}

async function fillTextarea(page, text) {
  await page.bringToFront();
  await page.waitForFunction(()=>{
    const el=document.querySelector('#prompt-textarea');
    return el && el.getBoundingClientRect().height>0 && (el.isContentEditable || el.tagName==='TEXTAREA');
  },{timeout:60000});
  const normalized=s=>s.replace(/\r/g,'').replace(/\n+/g,'\n').trim();
  for(let attempt=0;attempt<3;attempt++) {
    await page.focus('#prompt-textarea');
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await page.keyboard.sendCharacter(text);
    await new Promise(r=>setTimeout(r,400));
    const actual=await page.$eval('#prompt-textarea',el=>el.value ?? el.innerText);
    if(normalized(actual)===normalized(text)) return;
  }
  throw new Error('Composer failed verified insertion after 3 attempts; nothing submitted');
}

async function resetNewChatComposer(page, log) {
  await page.waitForFunction(()=>{
    const el=document.querySelector('#prompt-textarea');
    return el && el.getBoundingClientRect().height>0;
  },{timeout:60000});
  // Failed large submissions are persisted by ChatGPT as drafts. Remove only
  // those unsent attachments and text before starting the next mapped chat.
  await page.evaluate(() => {
    for (const button of document.querySelectorAll('button[aria-label^="Remove file "]')) button.click();
  });
  await page.focus('#prompt-textarea');
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await new Promise(r=>setTimeout(r,400));
  log('New-chat composer reset and verified ready.');
}

async function readProviderRejection(page) {
  return page.evaluate(() => {
    const selectors='[role="alert"], [aria-live="assertive"], [data-testid*="toast"], [class*="toast"]';
    const visible=[...document.querySelectorAll(selectors)]
      .filter(el=>el.getBoundingClientRect().height>0)
      .map(el=>(el.innerText||el.textContent||'').trim()).filter(Boolean).join('\n');
    // Do not scan the entire conversation: a historical rejected turn remains
    // in the DOM and would poison every later request forever.
    // Capacity banners are sometimes ordinary fixed-position text instead of
    // ARIA alerts. Read only the active composer neighbourhood as a bounded
    // fallback; never scan historical conversation turns.
    const composer=document.querySelector('#prompt-textarea');
    const composerRegion=composer?.closest('form') || composer?.parentElement?.parentElement;
    const nearby=(composerRegion?.innerText||'').trim();
    // Exact quota wording is safe to read globally: unlike generic request
    // errors it cannot be confused with normal historic assistant prose.
    const pageCapacity=(document.body?.innerText||'').match(/(?:Messages limit reached|You(?:'|’)ve reached your (?:message|usage) limit|Limite de mensagens (?:atingido|alcançado))[^\n]*/i)?.[0]||'';
    const text=[visible,nearby,pageCapacity].filter(Boolean).join('\n');
    const patterns=[
      /The message you submitted was too long[^\n]*/i,
      /Please edit it and resubmit[^\n]*/i,
      /A mensagem[^\n]{0,120}(?:muito longa|grande demais)[^\n]*/i,
      /Your request is too large[^\n]*/i,
      /Messages limit reached[^\n]*/i,
      /You(?:'|’)ve reached your (?:message|usage) limit[^\n]*/i,
      /Limite de mensagens (?:atingido|alcançado)[^\n]*/i,
    ];
    for(const pattern of patterns) {
      const match=text.match(pattern);
      if(match) return match[0].trim().slice(0,500);
    }
    return '';
  }).catch(()=> '');
}

async function waitForStreamingDone(page, log, beforeCount, requestDeadline) {
  // beforeCount must be measured BEFORE the message is sent so we don't
  // accidentally measure it after ChatGPT has already started responding.
  // The caller passes it in; fall back to measuring now only for text-only paths.
  if (beforeCount === undefined) {
    beforeCount = await page.evaluate(
      () => document.querySelectorAll('[data-message-author-role="assistant"]').length
    );
  }
  log(`waitForStreamingDone: beforeCount=${beforeCount}`);

  // Phase 1 — wait for a new assistant turn, while recognizing provider-side
  // rejection banners immediately instead of converting them into a 5-minute
  // timeout.
  try {
    const startDeadline=Math.min(
      requestDeadline,
      Date.now()+RESPONSE_START_TIMEOUT
    );
    while(Date.now()<startDeadline) {
      const rejection=await readProviderRejection(page);
      if(rejection) throw new Error(`ChatGPT rejected the request: ${rejection}`);
      const started=await page.evaluate(before => {
        const msgs=document.querySelectorAll('[data-message-author-role="assistant"]');
        const last=msgs[msgs.length-1];
        const turn=last?.closest('[data-testid^="conversation-turn-"]')?.getAttribute('data-testid');
        const text=(last?.innerText||'').trim();
        return !!turn && turn!==before && text ? text : '';
      },beforeCount).catch(()=>'');
      if(started) {
        if(/message you submitted was too long|please edit it and resubmit|request is too large/i.test(started))
          throw new Error(`ChatGPT rejected the request: ${started.slice(0,500)}`);
        break;
      }
      await new Promise(r=>setTimeout(r,1000));
    }
    if(Date.now()>=startDeadline) {
      const error=new Error('Timed out waiting for ChatGPT to start responding');
      error.code='CHATGPT_RESPONSE_START_TIMEOUT';
      throw error;
    }
  } catch(err) {
    // On timeout, dump the DOM state to the log for debugging
    const dump = await page.evaluate(() => {
      const assistants = [...document.querySelectorAll('[data-message-author-role="assistant"]')]
        .map(el => el.innerText.trim().slice(0, 100));
      const allRoles = [...document.querySelectorAll('[data-message-author-role]')]
        .map(el => `${el.getAttribute('data-message-author-role')}: ${(el.innerText||'').trim().slice(0,80)}`);
      const buttons = [...document.querySelectorAll('button')].map(b => b.getAttribute('aria-label') || b.textContent.trim().slice(0,30)).filter(Boolean);
      const url = location.href;
      return { assistants, allRoles, buttons: buttons.slice(0,15), url };
    }).catch(() => ({ error: 'page.evaluate failed' }));
    log(`waitForStreamingDone TIMEOUT dump: ${JSON.stringify(dump)}`);
    throw err;
  }

  // A pause in token output is NOT completion. Require generation controls
  // to be idle, a final response action, and stable full text, with a deadline.
  let lastText = '';
  let stableCount = 0;
  let stableEnvelope = '';
  let envelopeSince = 0;
  const deadline = requestDeadline;
  while (stableCount < 3) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for final response; partial text not returned');
    await new Promise(r => setTimeout(r, 1000));
    const state = await page.evaluate(() => {
      const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
      const last = msgs[msgs.length - 1];
      const turn = last?.closest('[data-testid^="conversation-turn-"], article');
      const codes=last?.querySelectorAll('pre code');
      let envelope='';
      if(codes?.length===1) {
        const raw=codes[0].textContent.trim();
        try {
          const obj=JSON.parse(raw);
          if(obj && Array.isArray(obj.thoughts) && typeof obj.headline==='string'
            && typeof obj.tool_name==='string' && obj.tool_args && typeof obj.tool_args==='object'
            && (obj.tool_name!=='response' || typeof obj.tool_args.text==='string')) envelope=raw;
          if(obj && Object.keys(obj).length===1 && typeof obj.browser_utility_text==='string') envelope=raw;
        } catch {}
      }
      return {text:last?.innerText || '',envelope,
        failed:!!turn?.querySelector('button[data-testid="regenerate-thread-error-button"]'),
        busy:!!document.querySelector('button[data-testid="stop-button"],button[aria-label="Stop generating"],[data-is-streaming="true"]'),
        final:!!turn?.querySelector('button[data-testid="copy-turn-action-button"],button[data-testid="good-response-turn-action-button"],button[data-testid="bad-response-turn-action-button"]')};
    });
    if(state.failed) throw new Error('ChatGPT rejected the request: '+state.text.slice(0,180));
    if (!state.busy && state.final && state.text && state.text === lastText) stableCount++;
    else stableCount = 0;
    lastText = state.text;
    if(state.envelope && state.envelope===stableEnvelope) {
      if(Date.now()-envelopeSince>=15000) {
        // A single complete machine envelope is the entire A0 response.
        // Quiesce this generation before releasing the serialized browser.
        const stop=await page.$('button[data-testid="stop-button"]');
        if(stop) await stop.click();
        // Some UI versions leave the stop control mounted after cancellation.
        // Verify the atomic payload, then detach this page from the old stream.
        const current=await extractLastAssistantMessage(page);
        if(current!==state.envelope) throw new Error('Response changed while recovering stalled generation');
        if (/^https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+$/.test(page.url()))
          fs.writeFileSync(SESSION_FILE, page.url(), 'utf8');
        await page.goto('about:blank',{waitUntil:'domcontentloaded',timeout:10000});
        log('Recovered complete JSON envelope after 15 seconds unchanged; page quiesced');
        return state.envelope;
      }
    } else {stableEnvelope=state.envelope;envelopeSince=Date.now();}
  }
}

async function extractLastAssistantMessage(page) {
  return page.evaluate(() => {
    const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (msgs.length > 0) {
      const last = msgs[msgs.length - 1];
      const blocks = last.querySelectorAll('pre code');
      // Machine JSON must be read verbatim, not from rendered Markdown.
      if (blocks.length === 1) {
        const code = blocks[0].textContent.trim();
        try {
          const parsed = JSON.parse(code);
          if (parsed !== null && typeof parsed === 'object') return code;
        } catch { /* preserve visible response for bounded format retry */ }
      }
      return last.innerText.trim();
    }
    // Never fall back to arbitrary prose from another turn/page.
    return null;
  });
}

// ─── Daemon process ───────────────────────────────────────────────────────────

async function startDaemonProcess() {
  const logStream = fs.createWriteStream(DAEMON_LOG, { flags: 'a' });
  const log = msg => logStream.write(`[${new Date().toISOString()}] ${msg}\n`);

  log('Daemon starting...');

  let browser, page;
  try {
    browser = await launchBrowser();
    page    = await browser.newPage();

    const initUrl = fs.existsSync(SESSION_FILE)
      ? fs.readFileSync(SESSION_FILE, 'utf8').trim()
      : CHATGPT_URL;

    log(`Navigating to ${initUrl}`);
    await page.goto(
      initUrl.startsWith('https://chatgpt.com') ? initUrl : CHATGPT_URL,
      { waitUntil: 'domcontentloaded', timeout: 60_000 }
    );

    const loggedOut = await page.evaluate(() => {
      const hasLoginBtn = [...document.querySelectorAll('button, a')]
        .some(el => ['Log in', 'Sign in'].includes(el.textContent.trim()));
      const hasInput = !!document.querySelector('#prompt-textarea');
      return hasLoginBtn && !hasInput;
    });

    if (loggedOut) {
      log('ERROR: Not logged in. Run: node chatgpt.js --login');
      await browser.close();
      process.exit(1);
    }

    log('Browser ready and logged in.');
  } catch (err) {
    log(`Startup error: ${err.message}`);
    if (browser) await browser.close().catch(() => {});
    process.exit(1);
  }

  // Serialize requests — ChatGPT is one-at-a-time.
  let busy = false;

  const server = http.createServer(async (req, res) => {
    const send = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (req.method === 'GET' && req.url === '/status') {
      return send(200, { ok: true, pid: process.pid });
    }

    if (req.method === 'GET' && req.url === '/diagnostics') {
      const browserState=await page.evaluate(() => ({
        webdriver: navigator.webdriver,
        userAgent: navigator.userAgent,
        languages: navigator.languages,
        hasChromeObject: Boolean(globalThis.chrome),
      }));
      return send(200, { ok: true, browser: browserState });
    }

    if (req.method === 'POST' && req.url === '/stop') {
      send(200, { ok: true });
      log('Shutting down...');
      server.close();
      await browser.close().catch(() => {});
      if (fs.existsSync(DAEMON_FILE)) fs.unlinkSync(DAEMON_FILE);
      process.exit(0);
    }

    if (req.method === 'POST' && req.url === '/ask') {
      if (busy) return send(503, { ok: false, error: 'Daemon busy — try again in a moment.' });
      busy = true;

      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', async () => {
        const {
          fullPrompt, codeOnly, newChat, uploadPath, chatUrl,
          reloadBeforeAttempt=false, requestTimeoutMs=REQUEST_TIMEOUT,
        } = JSON.parse(body);
        const boundedRequestTimeout=Math.max(
          1_000,
          Math.min(REQUEST_TIMEOUT, Number(requestTimeoutMs) || REQUEST_TIMEOUT)
        );
        const requestDeadline=Date.now()+boundedRequestTimeout;
        const remainingTimeout=(cap=60_000)=>Math.max(
          1_000,
          Math.min(cap, requestDeadline-Date.now())
        );
        log(`ask: newChat=${newChat} reload=${reloadBeforeAttempt} budgetMs=${boundedRequestTimeout} codeOnly=${codeOnly} upload=${uploadPath||'none'} chatUrl=${chatUrl||'none'} len=${fullPrompt.length}`);

        try {
          if (reloadBeforeAttempt) {
            log('Recovery attempt: reloading the current ChatGPT page once');
            await page.reload({
              waitUntil:'domcontentloaded',
              timeout:remainingTimeout(),
            });
            await page.waitForSelector('#prompt-textarea', {
              timeout:remainingTimeout(),
            });
          }

          const currentUrl = page.url().split('?')[0];

          if (chatUrl) {
            if (!/^https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+$/.test(chatUrl)) throw new Error('Invalid conversation URL');
            if (currentUrl !== chatUrl) {
              log(`Switching to mapped chat URL: ${chatUrl}`);
              await page.goto(chatUrl, {
                waitUntil:'domcontentloaded',
                timeout:remainingTimeout(),
              });
              await page.waitForSelector('#prompt-textarea', {
                timeout:remainingTimeout(),
              });
            } else {
              log(`Reusing mapped chat without reload: ${chatUrl}`);
            }
            if (page.url().split('?')[0] !== chatUrl) throw new Error('Conversation not accessible; refusing another chat');
          } else if (newChat) {
            log('Starting new chat with one fresh page load...');
            await page.goto(CHATGPT_URL, {
              waitUntil:'domcontentloaded',
              timeout:remainingTimeout(),
            });
            await resetNewChatComposer(page, log);
            await page.waitForFunction(() => !document.querySelector('[data-message-author-role="assistant"]')
              && !!document.querySelector('#prompt-textarea'), {timeout:remainingTimeout()});
          } else if (!currentUrl.startsWith('https://chatgpt.com')) {
            // Tab drifted (e.g. browser opened a link) — restore
            const sessionUrl = fs.existsSync(SESSION_FILE)
              ? fs.readFileSync(SESSION_FILE, 'utf8').trim()
              : CHATGPT_URL;
            log(`Restoring tab to ${sessionUrl}`);
            await page.goto(sessionUrl, {
              waitUntil:'domcontentloaded',
              timeout:remainingTimeout(),
            });
            await page.waitForSelector('#prompt-textarea', {
              timeout:remainingTimeout(),
            });
          }
          // else: already on the right chat page, skip navigation entirely

          // Attach first. Uploading causes ChatGPT to re-render the composer;
          // text inserted before that re-render can remain visible in the DOM
          // while being absent from React's submission state.
          if (uploadPath) {
            await uploadFileToChatGPT(page, uploadPath, log);
          }

          await dismissBlockingOverlays(page, log);
          await fillTextarea(page, fullPrompt);
          const inserted = await page.$eval('#prompt-textarea', el => el.value ?? el.innerText);
          // ProseMirror renders paragraphs as doubled line breaks in innerText.
          // JSON transcript newlines are escaped, so normalize only DOM line
          // separators, not spaces/indentation inside transcript values.
          const normalizeComposer = s => s.replace(/\r/g,'').replace(/\n+/g,'\n').trim();
          if (normalizeComposer(inserted) !== normalizeComposer(fullPrompt)) {
            const a=normalizeComposer(inserted), b=normalizeComposer(fullPrompt);
            let at=0; while(at<Math.min(a.length,b.length)&&a[at]===b[at]) at++;
            log(`Composer mismatch lengths=${a.length}/${b.length} offset=${at} codepoints=${a.charCodeAt(at)}/${b.charCodeAt(at)}`);
            throw new Error('Composer did not preserve the complete prompt; refusing to send partial context');
          }

          // If a file was uploaded, wait until the send button is enabled.
          // ChatGPT uploads the file to its servers in the background; the send
          // button stays disabled until that upload finishes.  Clicking a disabled
          // button does nothing, which is what caused the previous silent failures.
          const submitStartPath = new URL(page.url()).pathname;
          if (uploadPath) {
            log('Waiting for send button to become enabled (file upload in progress)...');
            await page.waitForFunction(
              () => {
                const btn = document.querySelector('button[data-testid="send-button"]');
                return btn && !btn.disabled;
              },
              { timeout: 60_000 }
            );
            log('Send button is now enabled.');
          }

          // Track stable turn identity, never the virtualized message count.
          const beforeTurn = await page.evaluate(() => ({
            assistant:[...document.querySelectorAll('[data-message-author-role="assistant"]')].at(-1)?.closest('[data-testid^="conversation-turn-"]')?.getAttribute('data-testid') || null,
            user:[...document.querySelectorAll('[data-message-author-role="user"]')].at(-1)?.closest('[data-testid^="conversation-turn-"]')?.getAttribute('data-testid') || null,
          }));

          // Uploaded attachments can steal the ProseMirror focus. In that state
          // Enter may be accepted without submitting anything, leaving a blank
          // ChatGPT home page until the response timeout. Use the enabled send
          // button for uploads and Enter for ordinary text, then require evidence
          // that the composer was actually submitted before waiting for a reply.
          // Clicking the enabled send control is more reliable than synthesizing
          // Enter on long-lived chats: after a provider rejection the editor can
          // look focused while ProseMirror consumes Enter as an edit operation.
          await page.waitForFunction(() => {
            const button=document.querySelector('button[data-testid="send-button"]');
            return button && !button.disabled;
          },{timeout:15000,polling:250});
          const capacityRejection=await readProviderRejection(page);
          if(capacityRejection) throw new Error(`ChatGPT rejected the request: ${capacityRejection}`);
          await dismissBlockingOverlays(page, log);
          await page.click('button[data-testid="send-button"]');
          log(uploadPath
            ? 'Submitted via DOM send action after attachment and composer refresh'
            : 'Submitted via verified DOM send action');
          await page.waitForFunction(
            ({startPath,beforeUser}) => {
              const editor = document.querySelector('#prompt-textarea');
              const text = (editor?.value ?? editor?.innerText ?? '').trim();
              const currentUser=[...document.querySelectorAll('[data-message-author-role="user"]')].at(-1)?.closest('[data-testid^="conversation-turn-"]')?.getAttribute('data-testid') || null;
              // Composer clearing alone is insufficient: a popup may consume a
              // click while React transiently redraws it. Require a new user
              // turn (or a new-chat navigation plus a user turn) as evidence.
              return !text && currentUser && currentUser!==beforeUser
                && (startPath!=='/' || location.pathname.startsWith('/c/'));
            },
            { timeout: 15_000, polling: 250 },
            {startPath:submitStartPath,beforeUser:beforeTurn.user}
          ).catch(async () => {
            await page.screenshot({path: path.join(STATE_DIR, 'submission-failure.png'), fullPage: false}).catch(() => {});
            const delayedRejection=await readProviderRejection(page);
            if(delayedRejection) throw new Error(`ChatGPT rejected the request: ${delayedRejection}`);
            const state = await page.evaluate(() => {
              const editor = document.querySelector('#prompt-textarea');
              const sendButton = document.querySelector('button[data-testid="send-button"]');
              return {
                path: location.pathname,
                composerChars: String(editor?.value ?? editor?.innerText ?? '').length,
                sendDisabled: sendButton?.disabled ?? null,
                sendLabel: sendButton?.getAttribute('aria-label') ?? null,
                files: [...document.querySelectorAll('[data-testid*="file"], [class*="attachment"]')].length,
                alerts: [...document.querySelectorAll('[role="alert"]')].map(el => el.innerText.trim()).filter(Boolean).slice(-3),
                capacityText: (document.body?.innerText||'').match(/(?:Messages limit reached|You(?:'|’)ve reached your (?:message|usage) limit|Limite de mensagens (?:atingido|alcançado))[^\n]*/i)?.[0]||'',
                buttons: [...document.querySelectorAll('button')].map(el => ({
                  testid: el.getAttribute('data-testid'),
                  label: el.getAttribute('aria-label'),
                  title: el.getAttribute('title'),
                })).filter(item => item.testid || item.label || item.title).slice(-20),
              };
            });
            if(state.capacityText) throw new Error(`ChatGPT rejected the request: ${state.capacityText}`);
            log(`Submission not acknowledged: ${JSON.stringify(state)}`);
            throw new Error('Prompt submission was not acknowledged');
          });

          const immediateRejection=await readProviderRejection(page);
          if(immediateRejection) throw new Error(`ChatGPT rejected the request: ${immediateRejection}`);

          // Persist the conversation as soon as ChatGPT acknowledges the user
          // turn. If response startup stalls, the bounded recovery attempt can
          // reload and retry in this same conversation instead of opening a
          // second unrelated chat.
          const submittedUrl=page.url().split('?')[0];
          if (/^https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+$/.test(submittedUrl)) {
            fs.writeFileSync(SESSION_FILE, submittedUrl, 'utf8');
          }

          log('Prompt sent, waiting for response...');
          const recovered = await waitForStreamingDone(
            page,
            log,
            beforeTurn.assistant,
            requestDeadline
          );

          const finalUrl = page.url();
          if (finalUrl.startsWith('https://chatgpt.com/c/')) {
            fs.writeFileSync(SESSION_FILE, finalUrl, 'utf8');
          }

          const raw = recovered || await extractLastAssistantMessage(page);
          if (!raw) throw new Error('Could not extract response from page');

          const output = codeOnly ? extractCodeBlocks(raw) : raw;
          log(`Done: ${output.length} chars`);
          send(200, { ok: true, response: output });
        } catch (err) {
          log(`Error: ${err.message}`);
          // Return the URL owned by this exact request.  The global session
          // file can already point at another Agent Zero conversation when a
          // recovery starts, which used to mix chats during the retry.
          const currentChatUrl = page.url().split('?')[0];
          const requestChatUrl = /^https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+$/.test(currentChatUrl)
            ? currentChatUrl
            : null;
          send(500, { ok: false, error: err.message, chatUrl: requestChatUrl });
        } finally {
          busy = false;
        }
      });
      return;
    }

    send(404, { ok: false, error: 'Not found' });
  });

  server.on('error', err => {
    log(`HTTP server error: ${err.message}`);
    process.exit(1);
  });

  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    log(`HTTP server listening on 127.0.0.1:${port}`);
    fs.writeFileSync(DAEMON_FILE, JSON.stringify({ port, pid: process.pid }), 'utf8');
    log('Daemon ready.');
  });

  const shutdown = async signal => {
    log(`${signal} received, shutting down`);
    if (fs.existsSync(DAEMON_FILE)) fs.unlinkSync(DAEMON_FILE);
    await browser.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
  // never returns — stays alive as the server
}

// ─── Client helpers ───────────────────────────────────────────────────────────

function readDaemonState() {
  if (!fs.existsSync(DAEMON_FILE)) return null;
  try {
    const state = JSON.parse(fs.readFileSync(DAEMON_FILE, 'utf8'));
    process.kill(state.pid, 0); // throws if PID is dead
    return state;
  } catch {
    return null;
  }
}

function httpPost(port, endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: '127.0.0.1', port, path: endpoint, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      res => {
        let raw = '';
        res.on('data', c => (raw += c));
        res.on('end', () => {
          try { resolve(JSON.parse(raw)); }
          catch { reject(new Error('Invalid JSON from daemon')); }
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function ensureDaemon() {
  let state = readDaemonState();
  if (state) return state.port;

  if (fs.existsSync(MANUAL_LOGIN_FILE)) {
    throw new Error('Manual ChatGPT login is active in VNC. Finish the login and close the manual Chrome window before using this model.');
  }

  if (fs.existsSync(DAEMON_FILE)) fs.unlinkSync(DAEMON_FILE); // clean stale file

  process.stderr.write('[*] Starting browser daemon (first time ~15s)...\n');

  const child = spawn(process.execPath, [__filename, '--daemon-internal'], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env },
  });
  child.unref();

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1_000));
    state = readDaemonState();
    if (state) {
      await new Promise(r => setTimeout(r, 300)); // let HTTP server bind
      process.stderr.write('[*] Daemon ready.\n');
      return state.port;
    }
  }

  throw new Error('Daemon did not start. Check: cat ~/.chatgpt-poc-daemon.log');
}

// ─── Login (one-time setup, no daemon) ───────────────────────────────────────

function waitForEnter(prompt) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

async function login() {
  console.log('[*] Opening Chrome for login...');
  const browser = await launchBrowser();
  const page = await browser.newPage();
  await page.goto(CHATGPT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  console.log('');
  console.log('  Log in to chatgpt.com in the Chrome window that opened.');
  console.log('  When fully logged in and the chat interface is visible,');
  await waitForEnter('  press Enter here to save the session: ');
  await browser.close();
  console.log('[*] Done. Run: node chatgpt.js "your prompt here"');
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    login: false, codeOnly: false, file: null, upload: null, save: null,
    git: false, context: null, newChat: false, chatUrl: null, stop: false, status: false,
    daemonInternal: false, cwd: null, prompt: [], rawStdin: false,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--login':           opts.login          = true;  break;
      case '--code':            opts.codeOnly       = true;  break;
      case '--git':             opts.git            = true;  break;
      case '--new':             opts.newChat        = true;  break;
      case '--chat-url':          opts.chatUrl   = args[++i];    break;
      case '--raw-stdin':       opts.rawStdin       = true;  break;
      case '--stop':            opts.stop           = true;  break;
      case '--status':          opts.status         = true;  break;
      case '--daemon-internal': opts.daemonInternal = true;  break;
      case '--file':            opts.file    = args[++i];    break;
      case '--upload':          opts.upload  = args[++i];    break;
      case '--save':            opts.save    = args[++i];    break;
      case '--context':         opts.context = args[++i];    break;
      case '--cwd':             opts.cwd     = args[++i];    break;
      default:                  opts.prompt.push(args[i]);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`
Usage:
  node chatgpt.js --login                               # first-time setup
  node chatgpt.js "prompt"                              # continue last chat (daemon auto-starts)
  node chatgpt.js --new "prompt"                        # force a new chat
  node chatgpt.js --code "write fizzbuzz in Go"         # extract code blocks only
  node chatgpt.js --file <path> "prompt"                # paste file content as text in prompt
  node chatgpt.js --upload <path> "prompt"              # upload file via ChatGPT attachment button
  node chatgpt.js --save <path> "prompt"                # save response to a file
  node chatgpt.js --git "write a commit message"        # attach git diff/status
  node chatgpt.js --context "we use Fiber v2" "prompt"  # inline context
  cat error.log | node chatgpt.js "what is wrong"       # pipe input
  node chatgpt.js --status                              # check if daemon is running
  node chatgpt.js --stop                                # shut down the daemon
`);
}

(async () => {
  const opts = parseArgs(process.argv);

  if (opts.daemonInternal) {
    await startDaemonProcess(); // never returns
    return;
  }

  if (opts.login) {
    await login().catch(err => { console.error('[ERROR]', err.message); process.exit(1); });
    return;
  }

  if (opts.stop) {
    const state = readDaemonState();
    if (!state) { console.log('[*] No daemon running.'); return; }
    try {
      await httpPost(state.port, '/stop', {});
      console.log('[*] Daemon stopped.');
    } catch {
      if (fs.existsSync(DAEMON_FILE)) fs.unlinkSync(DAEMON_FILE);
      console.log('[*] Daemon stopped.');
    }
    return;
  }

  if (opts.status) {
    const state = readDaemonState();
    if (!state) { console.log('[*] Daemon not running.'); return; }
    console.log(`[*] Daemon running — PID ${state.pid}, port ${state.port}`);
    return;
  }

  if (opts.prompt.length === 0 && !opts.rawStdin) {
    printHelp();
    process.exit(1);
  }

  const userPrompt  = opts.prompt.join(' ');
  const stdinData   = await readStdin();
  const fileData    = opts.file    ? readFile(opts.file)  : null;
  const gitData     = opts.git     ? getGitContext(opts.cwd || process.cwd()) : null;
  const contextData = opts.context || null;

  const fullPrompt = opts.rawStdin ? stdinData : buildFullPrompt({ userPrompt, stdinData, fileData, gitData, contextData });
  if (!fullPrompt) throw new Error('Empty prompt');

  try {
    const port   = await ensureDaemon();
    const result = await httpPost(port, '/ask', {
      fullPrompt, codeOnly: opts.codeOnly, newChat: opts.newChat, chatUrl: opts.chatUrl,
      uploadPath: opts.upload || null,
      reloadBeforeAttempt: process.env.BROWSER_RECOVERY_RELOAD === '1',
      requestTimeoutMs: Number(process.env.BROWSER_REQUEST_TIMEOUT_MS || REQUEST_TIMEOUT),
    });
    if (!result.ok) {
      const chatUrlMarker = result.chatUrl ? ` CHATGPT_REQUEST_URL=${result.chatUrl}` : '';
      throw new Error((result.error || 'Daemon returned an error') + chatUrlMarker);
    }
    console.log('\n--- RESPONSE ---');
    console.log(result.response);
    console.log('--- END ---\n');
    if (opts.save) {
      fs.writeFileSync(path.resolve(opts.save), result.response, 'utf8');
      console.error(`[*] Response saved to: ${path.resolve(opts.save)}`);
    }
  } catch (err) {
    console.error('[ERROR]', err.message);
    process.exit(1);
  }
})();
