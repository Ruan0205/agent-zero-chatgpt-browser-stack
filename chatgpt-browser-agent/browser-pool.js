'use strict';

class BrowserPool {
  constructor(options={}) {
    this.minSize=Math.max(2,Number(options.minSize)||2);
    this.idleMs=Math.max(1_000,Number(options.idleMs)||1_800_000);
    this.onWarm=options.onWarm || (async()=>{});
    this.onStop=options.onStop || (async()=>{});
    this.onCheck=options.onCheck || null;
    this.onScale=options.onScale || (async()=>{});
    this.loadAssignments=options.loadAssignments || (()=>({}));
    this.saveAssignments=options.saveAssignments || (()=>{});
    this.assignments={...this.loadAssignments()};
    this.slots=new Map();
    this.nextId=1;
    this.watchdog=null;
    this.checking=false;
  }

  _slotId(number) { return `browser-${number}`; }

  _numberFromId(id) {
    const match=String(id||'').match(/^browser-(\d+)$/);
    return match ? Number(match[1]) : 0;
  }

  _ensureSlot(id,permanent=false) {
    if(this.slots.has(id)) {
      const slot=this.slots.get(id);
      if(permanent) slot.permanent=true;
      return slot;
    }
    this.nextId=Math.max(this.nextId,this._numberFromId(id)+1);
    const slot={
      id,
      permanent:Boolean(permanent),
      busy:false,
      queued:0,
      state:'stopped',
      ready:null,
      tail:Promise.resolve(),
      lastUsed:0,
      idleTimer:null,
    };
    this.slots.set(id,slot);
    return slot;
  }

  _ensureAssignmentSlots() {
    for(const id of Object.values(this.assignments)) {
      if(this._numberFromId(id)>0) this._ensureSlot(id,this._numberFromId(id)<=this.minSize);
    }
  }

  async start() {
    this._ensureAssignmentSlots();
    const warms=[];
    for(let number=1;number<=this.minSize;number++) {
      const slot=this._ensureSlot(this._slotId(number),true);
      warms.push(this._warm(slot));
    }
    await Promise.all(warms);
    this.watchdog=setInterval(async()=>{
      if(this.checking) return;
      this.checking=true;
      try {
        for(const slot of this.slots.values()) {
          if(!slot.permanent || slot.busy || slot.queued>0) continue;
          if(slot.state==='stopped') {
            await this._warm(slot);
          } else if(slot.state==='ready' && this.onCheck) {
            await this.onCheck(slot);
          }
        }
      } catch(error) {
        console.error(`[pool] permanent-browser watchdog: ${error.message}`);
      } finally {
        this.checking=false;
      }
    },60_000);
    this.watchdog.unref?.();
  }

  async _warm(slot) {
    if(slot.state==='ready') return slot;
    if(slot.ready) return slot.ready;
    if(slot.idleTimer) clearTimeout(slot.idleTimer);
    slot.idleTimer=null;
    slot.state='warming';
    slot.ready=(async()=>{
      try {
        await this.onWarm(slot);
        slot.state='ready';
        return slot;
      } catch(error) {
        slot.state='stopped';
        throw error;
      } finally {
        slot.ready=null;
      }
    })();
    return slot.ready;
  }

  _leastLoadedReadySlot() {
    return [...this.slots.values()]
      .filter(slot=>slot.state==='ready' || slot.state==='warming')
      .sort((a,b)=>{
        const loadA=(a.busy?1:0)+a.queued;
        const loadB=(b.busy?1:0)+b.queued;
        if(loadA!==loadB) return loadA-loadB;
        if(a.state!==b.state) return a.state==='ready' ? -1 : 1;
        return a.lastUsed-b.lastUsed || this._numberFromId(a.id)-this._numberFromId(b.id);
      })[0] || null;
  }

  _newDynamicSlot() {
    while(this.slots.has(this._slotId(this.nextId))) this.nextId+=1;
    return this._ensureSlot(this._slotId(this.nextId++),false);
  }

  async _acquire(conversationKey,metadata={}) {
    let slot=null;
    const assigned=this.assignments[conversationKey];
    if(assigned) slot=this._ensureSlot(assigned,this._numberFromId(assigned)<=this.minSize);

    let scaled=false;
    if(!slot) {
      const candidate=this._leastLoadedReadySlot();
      const candidateLoad=candidate ? (candidate.busy?1:0)+candidate.queued : Number.POSITIVE_INFINITY;
      if(candidate && candidateLoad===0) slot=candidate;
      else {
        const reusable=[...this.slots.values()]
          .filter(item=>!item.permanent && item.state==='stopped' && !item.busy && item.queued===0)
          .sort((a,b)=>a.lastUsed-b.lastUsed)[0];
        slot=reusable || this._newDynamicSlot();
        scaled=true;
      }
      this.assignments[conversationKey]=slot.id;
      this.saveAssignments(this.assignments);
    } else if(slot.state==='stopped') {
      scaled=!slot.permanent;
    }

    slot.queued+=1;
    if(scaled) await this.onScale({slot,conversationKey,metadata,message:'subindo uma nova instancia de navegador'});
    return slot;
  }

  async run(conversationKey,metadata,work) {
    const key=conversationKey || `anonymous:${Date.now()}:${Math.random()}`;
    const slot=await this._acquire(key,metadata);
    const execute=async()=>{
      slot.queued=Math.max(0,slot.queued-1);
      slot.busy=true;
      if(slot.idleTimer) clearTimeout(slot.idleTimer);
      slot.idleTimer=null;
      try {
        await this._warm(slot);
        return await work(slot);
      } finally {
        slot.busy=false;
        slot.lastUsed=Date.now();
        this._scheduleIdleStop(slot);
      }
    };
    const result=slot.tail.then(execute,execute);
    slot.tail=result.catch(()=>{});
    return result;
  }

  _scheduleIdleStop(slot) {
    if(slot.permanent) return;
    if(slot.idleTimer) clearTimeout(slot.idleTimer);
    const scheduledAt=slot.lastUsed;
    slot.idleTimer=setTimeout(async()=>{
      slot.idleTimer=null;
      if(slot.busy || slot.queued>0 || slot.lastUsed!==scheduledAt) return;
      slot.state='stopping';
      try { await this.onStop(slot); }
      catch(error) { console.error(`[pool] failed to stop ${slot.id}: ${error.message}`); }
      finally { slot.state='stopped'; }
    },this.idleMs);
    slot.idleTimer.unref?.();
  }

  snapshot() {
    const assignmentCounts={};
    for(const id of Object.values(this.assignments)) assignmentCounts[id]=(assignmentCounts[id]||0)+1;
    return [...this.slots.values()]
      .sort((a,b)=>this._numberFromId(a.id)-this._numberFromId(b.id))
      .map(slot=>({
        id:slot.id,
        permanent:slot.permanent,
        state:slot.state,
        busy:slot.busy,
        queued:slot.queued,
        lastUsed:slot.lastUsed||null,
        conversations:assignmentCounts[slot.id]||0,
      }));
  }

  async shutdown() {
    if(this.watchdog) clearInterval(this.watchdog);
    this.watchdog=null;
    this.checking=false;
    for(const slot of this.slots.values()) if(slot.idleTimer) clearTimeout(slot.idleTimer);
    await Promise.allSettled([...this.slots.values()].map(slot=>this.onStop(slot)));
  }
}

module.exports={BrowserPool};
