'use strict';
// Remove only exact disposable smoke-test hashes supplied by the operator.
const fs=require('fs');
const path=require('path');
const base=process.env.CHATGPT_BROWSER_STATE_DIR || '/data';
const hashes=process.argv.slice(2);
if(!hashes.length || hashes.some(hash=>!/^v2-[0-9a-f]{64}$/.test(hash))) throw new Error('Expected explicit v2 SHA-256 hashes');
const mapFile=path.join(base,'.chatgpt-poc-chatmap.json');
const assignmentFile=path.join(base,'.chatgpt-poc-pool-assignments.json');
const map=JSON.parse(fs.readFileSync(mapFile,'utf8'));
const assignments=JSON.parse(fs.readFileSync(assignmentFile,'utf8'));
let removed=0;
for(const hash of hashes) {
  if(map[hash]) { delete map[hash]; removed++; }
  delete assignments[hash];
  fs.rmSync(path.join(base,hash+'-segments.json'),{force:true});
}
const save=(file,value)=>{
  const temp=file+'.smoke-cleanup.tmp';
  fs.writeFileSync(temp,JSON.stringify(value,null,2),{mode:0o600});
  fs.renameSync(temp,file);
};
save(mapFile,map);
save(assignmentFile,assignments);
console.log(`Removed ${removed} disposable browser bindings`);
