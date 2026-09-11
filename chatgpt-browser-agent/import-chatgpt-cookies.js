'use strict';

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/chromium';
const STATE_DIR = process.env.CHATGPT_BROWSER_STATE_DIR || '/data';
const PROFILE_DIR = path.join(STATE_DIR, '.chatgpt-poc-profile');

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => resolve(input));
    process.stdin.on('error', reject);
  });
}

(async () => {
  const input = await readStdin();
  const cookies = JSON.parse(input);
  if (!Array.isArray(cookies) || !cookies.length) throw new Error('Lista de cookies vazia');

  const allowed = cookies.filter(cookie => {
    const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
    return domain === 'chatgpt.com' || domain.endsWith('.chatgpt.com') ||
      domain === 'openai.com' || domain.endsWith('.openai.com');
  }).map(cookie => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || '/',
    expires: Number.isFinite(cookie.expires) ? cookie.expires : -1,
    httpOnly: Boolean(cookie.httpOnly),
    secure: Boolean(cookie.secure),
    sameSite: ['Strict', 'Lax', 'None'].includes(cookie.sameSite) ? cookie.sameSite : undefined,
  }));
  if (!allowed.length) throw new Error('Nenhum cookie permitido para importar');

  for (const file of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.rmSync(path.join(PROFILE_DIR, file), { force: true }); } catch {}
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    userDataDir: PROFILE_DIR,
    headless: false,
    args: ['--no-sandbox', '--no-first-run', '--no-default-browser-check'],
    defaultViewport: null,
  });
  await browser.setCookie(...allowed);
  const page = await browser.newPage();
  await page.goto('https://chatgpt.com/', { waitUntil: 'networkidle2', timeout: 60000 });
  const state = await page.evaluate(() => ({
    hasPrompt: Boolean(document.querySelector('#prompt-textarea')),
    hasLogin: [...document.querySelectorAll('button,a')]
      .some(el => /^(log in|sign in|entrar)$/i.test((el.textContent || '').trim())),
  }));
  await browser.close();
  console.log(JSON.stringify({ imported: allowed.length, authenticated: state.hasPrompt && !state.hasLogin }));
})().catch(error => {
  process.stderr.write(`IMPORT_ERROR: ${error.message}\n`);
  process.exit(1);
});
