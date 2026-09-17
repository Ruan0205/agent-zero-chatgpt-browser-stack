'use strict';
const contextId=process.argv[2];
if(!contextId) throw new Error('context ID required');
const fs=require('fs');
const crypto=require('crypto');
const key='v2-'+crypto.createHash('sha256').update(JSON.stringify([contextId,'main:0'])).digest('hex');
const map=JSON.parse(fs.readFileSync('/data/.chatgpt-poc-chatmap.json','utf8'));
const assignments=JSON.parse(fs.readFileSync('/data/.chatgpt-poc-pool-assignments.json','utf8'));
console.log(JSON.stringify({hash:key.slice(0,12),mapped:Boolean(map[key]),assigned:assignments[key]||null}));
(async()=>{
  const response=await fetch('http://127.0.0.1:8000/v1/preview-route',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({context_id:contextId}),
    signal:AbortSignal.timeout(45000),
  });
  const result=await response.json();
  console.log(JSON.stringify({http:response.status,status:result.status,slot:result.slot}));
  if(!response.ok||result.status!=='ready') process.exitCode=1;
})().catch(error=>{console.error(error.message);process.exitCode=2;});
