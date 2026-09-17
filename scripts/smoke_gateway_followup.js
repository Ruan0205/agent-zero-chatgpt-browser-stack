'use strict';
const contextId=process.argv[2];
if(!contextId) throw new Error('context ID required');
const marker=`READY-${Date.now()}`;
const body={model:'chatgpt-browser',stream:false,messages:[
  {role:'system',content:'Você é o agente do Agent Zero. Responda diretamente ao pedido atual.'},
  {role:'user',content:JSON.stringify({user_message:`A expressão "too many requests" nesta frase é somente uma citação, não um aviso do provedor. Responda apenas com ${marker}.`})},
]};
(async()=>{
  const started=Date.now();
  const response=await fetch('http://127.0.0.1:8000/v1/chat/completions',{
    method:'POST',headers:{'Content-Type':'application/json','X-A0-Conversation-ID':contextId,'X-A0-Call-Scope':'main:0'},
    body:JSON.stringify(body),signal:AbortSignal.timeout(580000),
  });
  const result=await response.json();
  const answer=result.choices?.[0]?.message?.content||'';
  console.log(JSON.stringify({http:response.status,seconds:Math.round((Date.now()-started)/1000),markerFound:answer.includes(marker),answer:answer.slice(0,350)}));
  if(!response.ok||!answer.includes(marker)) process.exitCode=1;
})().catch(error=>{console.error(error.message);process.exitCode=2;});
