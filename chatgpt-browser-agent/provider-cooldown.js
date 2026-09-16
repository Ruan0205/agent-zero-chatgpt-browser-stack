'use strict';
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');

class ProviderCooldown {
  constructor(options={}) {
    this.delayMs=Math.max(30_000,Number(options.delayMs)||30_000);
    this.now=options.now || Date.now;
    this.sleep=options.sleep || (ms=>new Promise(resolve=>setTimeout(resolve,ms)));
    this.directory=options.directory || '';
    this.until=0;
  }

  sharedUntil() {
    if(!this.directory) return 0;
    try {
      let latest=0;
      for(const name of fs.readdirSync(this.directory)) {
        const match=name.match(/^(\d+)-[a-f0-9-]+$/);
        if(!match) continue;
        const until=Number(match[1]);
        if(until<=this.now()) {
          try {fs.unlinkSync(path.join(this.directory,name));} catch {}
        } else latest=Math.max(latest,until);
      }
      return latest;
    } catch(error) {
      if(error.code!=='ENOENT') console.warn(`[provider-429] shared cooldown unavailable: ${error.message}`);
      return 0;
    }
  }

  block() {
    this.until=Math.max(this.until,this.sharedUntil(),this.now()+this.delayMs);
    if(this.directory) {
      try {
        fs.mkdirSync(this.directory,{recursive:true,mode:0o700});
        fs.writeFileSync(path.join(this.directory,`${this.until}-${crypto.randomUUID()}`),'',{mode:0o600,flag:'wx'});
      } catch(error) {console.warn(`[provider-429] failed to share cooldown: ${error.message}`);}
    }
    return this.until;
  }

  async wait() {
    while(this.now()<Math.max(this.until,this.sharedUntil()))
      await this.sleep(Math.max(this.until,this.sharedUntil())-this.now());
  }
}

module.exports={ProviderCooldown};
