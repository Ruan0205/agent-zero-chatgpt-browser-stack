const puppeteer = require('puppeteer-core');

(async () => {
  const port = process.argv[2];
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}` });
  const pages = await browser.pages();
  const page = pages.find(p => p.url().startsWith('https://chatgpt.com'));
  if (!page) throw new Error('ChatGPT page not found');
  const state = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    hasPrompt: Boolean(document.querySelector('#prompt-textarea')),
    hasLogin: [...document.querySelectorAll('button,a')].some(el => /^(log in|sign in|entrar)$/i.test((el.textContent || '').trim())),
  }));
  console.log(JSON.stringify(state));
  await browser.disconnect();
})().catch(error => { console.error(error.message); process.exit(1); });
