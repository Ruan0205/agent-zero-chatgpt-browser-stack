const puppeteer = require('/app/node_modules/puppeteer-core');

const base = process.env.AGENT_ZERO_E2E_URL || 'http://agent-zero';
const user = process.env.AUTH_LOGIN;
const password = process.env.AUTH_PASSWORD;
if (!user || !password) throw new Error('AUTH_LOGIN/AUTH_PASSWORD are required');

(async () => {
  const browser = await puppeteer.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
  let page, context;
  try {
    page = await browser.newPage();
    await page.goto(`${base}/login?next=/`,{waitUntil:'networkidle2'});
    await page.type('#username',user);
    await page.type('#password',password);
    await Promise.all([page.waitForNavigation({waitUntil:'networkidle2'}),page.click('button[type="submit"]')]);
    await page.waitForSelector('#newChat');
    await page.click('#newChat');
    await page.waitForFunction(() => typeof globalThis.getContext==='function' && !!globalThis.getContext());
    await page.waitForSelector('#chat-input[contenteditable="true"]',{timeout:20000});
    context=await page.evaluate(() => globalThis.getContext());
    const requests=[];
    page.on('request',req=>{if(req.url().endsWith('/message_async') && req.method()==='POST') requests.push(req.url());});
    await page.$eval('#chat-input',el=>{
      const value='E2E-DOUBLE-SUBMIT-20260930';
      el.focus();el.textContent=value;
      el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));
    });
    await page.evaluate(() => {const button=document.querySelector('#send-button');button.click();button.click();});
    await page.waitForFunction(() => document.querySelector('.durable-queue')?.innerText.includes('Mensagem em execução') || document.body.innerText.includes('E2E-DOUBLE-SUBMIT-20260930'),{timeout:20000});
    await new Promise(resolve=>setTimeout(resolve,1500));
    const evidence=await page.evaluate(() => ({
      matchingUserBubbles:[...document.querySelectorAll('.message-user')].filter(e=>e.innerText.includes('E2E-DOUBLE-SUBMIT-20260930')).length,
      matchingQueueRows:[...document.querySelectorAll('.dq-item')].filter(e=>e.innerText.includes('E2E-DOUBLE-SUBMIT-20260930')).length,
      queue:document.querySelector('.durable-queue')?.innerText.slice(0,300),
    }));
    console.log(JSON.stringify({context,postCount:requests.length,...evidence,passed:requests.length===1 && evidence.matchingUserBubbles+evidence.matchingQueueRows<=1}));
    if(requests.length!==1 || evidence.matchingUserBubbles+evidence.matchingQueueRows>1) process.exitCode=1;
  } finally {
    if(page && context) await page.evaluate(async ctx=>{await globalThis.sendJsonData('/chat_remove',{context:ctx});},context).catch(()=>{});
    await browser.close();
  }
})().catch(error=>{console.error(String(error.stack||error));process.exitCode=1;});
