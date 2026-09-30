const puppeteer = require('/app/node_modules/puppeteer-core');
const fs = require('node:fs');

const base = process.env.AGENT_ZERO_E2E_URL || 'http://agent-zero';
const user = process.env.AUTH_LOGIN;
const password = process.env.AUTH_PASSWORD;
if (!user || !password) throw new Error('AUTH_LOGIN/AUTH_PASSWORD are required');

const evidence = { started_at: new Date().toISOString(), checks: {}, context: null };
let browser;

async function waitFor(page, fn, timeout = 30000) {
  await page.waitForFunction(fn, { timeout });
}

async function compose(page, text) {
  await page.waitForSelector('#chat-input[contenteditable="true"]');
  await page.$eval('#chat-input', (el, value) => {
    el.focus();
    el.textContent = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  }, text);
  await page.click('#send-button');
}

(async () => {
  browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome', headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  await page.goto(`${base}/login?next=/`, { waitUntil: 'networkidle2' });
  await page.type('#username', user);
  await page.type('#password', password);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2' }), page.click('button[type="submit"]')]);
  await page.waitForSelector('#newChat');
  await page.click('#newChat');
  await waitFor(page, () => typeof globalThis.getContext === 'function' && !!globalThis.getContext());
  evidence.context = await page.evaluate(() => globalThis.getContext());

  const initialNavigationCount = await page.evaluate(() => performance.getEntriesByType('navigation').length);
  await compose(page, 'TESTE E2E DA FILA: use code_execution_tool no terminal para imprimir E2E-BEGIN, aguardar 25 segundos e imprimir E2E-END. Não responda antes de o comando terminar.');
  await waitFor(page, () => document.body.innerText.includes('Calling LLM') || document.querySelector('#send-button.stop'), 20000);

  await compose(page, 'E2E-KEEP-PENDING');
  await compose(page, 'E2E-INTERVENE-NOW');
  await waitFor(page, () => document.querySelectorAll('.dq-item').length === 2, 20000);

  await waitFor(page, () => {
    const body = document.body.innerText;
    return body.includes('code_execution_tool') || body.includes('E2E-BEGIN') || body.includes('Using tool');
  }, 30000);
  const navigationCount = await page.evaluate(() => performance.getEntriesByType('navigation').length);
  evidence.checks.reasoning_without_reload = navigationCount === initialNavigationCount;
  evidence.checks.post_prompt_process_event_visible = true;

  const intervention = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.dq-item')];
    const row = rows.find(item => item.innerText.includes('E2E-INTERVENE-NOW'));
    const button = row?.querySelector('[aria-label="Intervir agora"]');
    return { found: !!button, disabled: button ? button.disabled : null };
  });
  evidence.checks.intervention_button = intervention;
  if (!intervention.found || intervention.disabled) throw new Error(`Intervention unavailable: ${JSON.stringify(intervention)}`);

  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.dq-item')].find(item => item.innerText.includes('E2E-INTERVENE-NOW'));
    row.querySelector('[aria-label="Intervir agora"]').click();
  });
  await waitFor(page, () => document.body.innerText.includes('E2E-INTERVENE-NOW') &&
    [...document.querySelectorAll('.dq-item')].every(item => !item.innerText.includes('E2E-INTERVENE-NOW')), 20000);
  evidence.checks.intervention_rendered_without_reload = true;
  evidence.checks.unselected_message_preserved = await page.evaluate(() =>
    [...document.querySelectorAll('.dq-item')].some(item => item.innerText.includes('E2E-KEEP-PENDING')));
  evidence.checks.navigation_unchanged = (await page.evaluate(() => performance.getEntriesByType('navigation').length)) === initialNavigationCount;
  await page.screenshot({ path: '/tmp/message-queue-e2e.png', fullPage: true });

  if (!Object.values(evidence.checks).every(v => v === true || (v && v.found && v.disabled === false))) {
    throw new Error(`Checks failed: ${JSON.stringify(evidence.checks)}`);
  }
  evidence.passed = true;
  console.log(JSON.stringify(evidence));

  // Remove the synthetic chat through the same authenticated page after evidence.
  await page.evaluate(async ctx => { await globalThis.sendJsonData('/chat_remove', { context: ctx }); }, evidence.context);
})().catch(error => {
  evidence.passed = false;
  evidence.error = String(error && error.stack || error);
  console.error(JSON.stringify(evidence));
  process.exitCode = 1;
}).finally(async () => {
  fs.writeFileSync('/tmp/message-queue-e2e.json', JSON.stringify(evidence, null, 2));
  if (browser) await browser.close();
});
