'use strict';

const id=`image-smoke-${Date.now()}`;
const prompt='Crie uma imagem PNG simples de um círculo vermelho sólido em fundo branco puro e entregue a imagem como arquivo PNG baixável. Não responda apenas com texto.';
const body={model:'chatgpt-browser',stream:false,messages:[{role:'system',content:'Você é o agente do Agent Zero. Atenda ao pedido atual.'},{role:'user',content:JSON.stringify({user_message:prompt})}]};
(async()=>{
  console.log(`CONTEXT_ID=${id}`);
  const response=await fetch('http://127.0.0.1:8000/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','X-A0-Conversation-ID':id,'X-A0-Call-Scope':'main:0'},body:JSON.stringify(body),signal:AbortSignal.timeout(600000)});
  const result=await response.json();
  const text=result.choices?.[0]?.message?.content||'';
  console.log(`STATUS=${response.status}`);
  console.log(`ANSWER=${text.slice(0,1000)}`);
  if(!response.ok) process.exitCode=1;
  else {
    const parsed=JSON.parse(text);
    const files=parsed.tool_args?.files||[];
    console.log(`FILES=${JSON.stringify(files.map(({name,size,mime})=>({name,size,mime})))}`);
    if(parsed.tool_name!=='chatgpt_browser_media'||!files.some(file=>/^image\//.test(file.mime)&&file.size>0)) process.exitCode=2;
  }
})().catch(error=>{console.error(error.message);process.exitCode=3;});
