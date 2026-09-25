/** Destructive storage tests: ONLY run in a dedicated test profile, never a player's tab. */
export async function runEquipmentRegressionBrowserChecks() {
  const passed=[];
  const check=(ok,label)=>{if(!ok)throw new Error(label);passed.push(label);};
  const eq=(a,b,label)=>check(JSON.stringify(a)===JSON.stringify(b),label);
  const key='rotw-prototype-save-v3-equipment-v1-encounters-v1',back=key+'-backup';
  const state=()=>window.__rotwDebug.snapshot().save;
  const gear=()=>window.__rotwDebug.equipment('korgan');
  const initial=structuredClone(state());
  const originalEntries=[key,back,'rotw-prototype-save-v3','rotw-prototype-save-v3-backup'].map(k=>[k,localStorage.getItem(k)]);
  const click=selector=>{
    const node=document.querySelector(selector);if(!node||node.disabled)throw new Error('Control unavailable: '+selector);node.click();
  };
  const close=()=>{if(document.querySelector('#panel-layer')?.getAttribute('aria-hidden')==='false')click('#close-panel');};
  const reset=()=>{
    close();for(const [k] of originalEntries)localStorage.removeItem(k);
    localStorage.setItem(key,JSON.stringify(initial));
    if(!window.__rotwDebug.loadGameState())throw new Error('Cannot restore initial test fixture');
    localStorage.removeItem(key);localStorage.removeItem(back);
  };
  const save=()=>window.__rotwDebug.saveGameState();
  const baseSave=()=>{if(!save())throw new Error('Initial save failed');return localStorage.getItem(key);};
  try {
    // A future/incompatible format must be protected on SAVE as well as LOAD.
    for(const [field,value] of [
      ['schemaVersion',99],['equipmentSchemaVersion',99],['equipmentCatalogId','future-catalog'],
      ['game_ruleset_version','future-rules'],['source_snapshot_id','future-source'],
    ]) {
      reset();const valid=baseSave();const future={...JSON.parse(valid),[field]:value};
      const bytes=JSON.stringify(future);localStorage.setItem(key,bytes);localStorage.setItem(back,valid);
      const before=state();
      check(save()===false,`SAVE rejects incompatible ${field}`);
      check(localStorage.getItem(key)===bytes,`SAVE preserves incompatible ${field} primary`);
      check(localStorage.getItem(back)===valid,`SAVE preserves backup on incompatible ${field}`);
      eq(state(),before,`failed SAVE does not mutate live state: ${field}`);
      check(window.__rotwDebug.loadGameState()===false,`LOAD does not fall back over incompatible ${field}`);
      eq(state(),before,`failed LOAD does not mutate live state: ${field}`);
    }
    reset();let valid=baseSave();let newer={...JSON.parse(valid),equipmentSchemaVersion:99};
    localStorage.removeItem(key);localStorage.setItem(back,JSON.stringify(newer));
    check(save()===false,'SAVE protects a sole future backup');
    check(localStorage.getItem(key)===null,'no new primary hides sole future backup');
    check(localStorage.getItem(back)===JSON.stringify(newer),'future backup bytes preserved');

    reset();valid=baseSave();localStorage.setItem(back,JSON.stringify(newer));
    check(save()===false,'SAVE does not overwrite future backup beside valid primary');
    check(localStorage.getItem(key)===valid,'current primary preserved beside future backup');

    for(const corrupt of ['BROKEN', 'null', '[]', '17']) {
      reset();valid=baseSave();localStorage.setItem(back,valid);localStorage.setItem(key,corrupt);
      check(save()===true,`SAVE replaces corrupt primary ${corrupt} with current valid state`);
      check(localStorage.getItem(back)===valid,`corrupt primary ${corrupt} never replaces good backup`);
      check(window.__rotwDebug.loadGameState()===true,`new primary loads after corrupt ${corrupt}`);
    }
    reset();valid=baseSave();const badWorld=JSON.parse(valid);
    badWorld.roster[0].inventoryItemIds=[];
    localStorage.setItem(back,valid);localStorage.setItem(key,JSON.stringify(badWorld));
    check(save()===true,'SAVE can replace structurally valid JSON with invalid item ownership');
    check(localStorage.getItem(back)===valid,'invalid world is not promoted to backup');

    reset();const first=baseSave();click('#inventory-command');click('#inventory-grid [data-item-id="korgan.hand_axe"]');click('#equipment-action');close();
    check(save()===true,'ordinary equipped SAVE succeeds');
    check(localStorage.getItem(back)===first,'ordinary SAVE rotates last valid primary into backup');
    check(JSON.parse(localStorage.getItem(key)).roster[0].equipment.weapon.id==='korgan.hand_axe','ordinary SAVE writes equipped identity');

    // Missing only one half of the equipment header is corruption, NOT legacy.
    for(const missing of ['equipmentSchemaVersion','equipmentCatalogId']) {
      reset();valid=baseSave();const broken=JSON.parse(valid);delete broken[missing];
      const bytes=JSON.stringify(broken);localStorage.setItem(key,bytes);localStorage.removeItem(back);const before=state();
      check(window.__rotwDebug.loadGameState()===false,`partial equipment header rejected: ${missing}`);
      eq(state(),before,`partial header cannot migrate or reset live state: ${missing}`);
      check(localStorage.getItem(key)===bytes,`partial header bytes retained: ${missing}`);
    }
    // Malformed modifier containers used to masquerade as normal plain items.
    for(const field of ['sockets','properties']) {
      reset();valid=baseSave();const broken=JSON.parse(valid);
      const inv=broken.inventories.find(([id])=>id==='korgan')[1];
      inv.items.find(item=>item.id==='korgan.hand_axe')[field]={hiddenModifier:123};
      localStorage.setItem(key,JSON.stringify(broken));localStorage.removeItem(back);const before=state();
      check(window.__rotwDebug.loadGameState()===false,`save rejects malformed ${field} object`);
      eq(state(),before,`malformed ${field} cannot replace live game`);
    }
    // Simulate quota failures at the Storage API, restoring the original method afterwards.
    for(const failKey of [key,back]) {
      reset();valid=baseSave();localStorage.setItem(back,valid);
      const previousPrimary=localStorage.getItem(key),previousBackup=localStorage.getItem(back),before=state();
      const proto=Object.getPrototypeOf(localStorage),original=proto.setItem;let tripped=false,ok;
      try {
        proto.setItem=function(k,v){if(String(k)===failKey&&!tripped){tripped=true;throw new DOMException('Test quota failure','QuotaExceededError');}return original.call(this,k,v);};
        ok=save();
      } finally {proto.setItem=original;}
      check(tripped && ok===false,`quota failure handled: ${failKey===key?'primary':'backup'}`);
      check(localStorage.getItem(key)===previousPrimary,'quota failure keeps previous primary');
      check(localStorage.getItem(back)===previousBackup,'quota failure restores previous backup');
      eq(state(),before,'quota failure leaves live game untouched');
    }
    // Stale drag: the old axe payload must not remove a newly equipped sword.
    reset();click('#inventory-command');click('#inventory-grid [data-item-id="korgan.hand_axe"]');click('#equipment-action');
    const oldDrag=new DataTransfer();
    document.querySelector('[data-equip-slot="weapon"]').dispatchEvent(new DragEvent('dragstart',{dataTransfer:oldDrag,bubbles:true}));
    click('[data-item-id="korgan.starter.short_sword"]');click('#equipment-action');
    const beforeDrag=gear();
    document.querySelectorAll('.inventory-cell')[39].dispatchEvent(new DragEvent('drop',{dataTransfer:oldDrag,bubbles:true,cancelable:true}));
    eq(gear(),beforeDrag,'stale equipped drag does not unequip replacement weapon');
    check(gear().equipment.weapon.id==='korgan.starter.short_sword','replacement sword stays equipped');
    const currentDrag=new DataTransfer();
    document.querySelector('[data-equip-slot="weapon"]').dispatchEvent(new DragEvent('dragstart',{dataTransfer:currentDrag,bubbles:true}));
    document.querySelectorAll('.inventory-cell')[39].dispatchEvent(new DragEvent('drop',{dataTransfer:currentDrag,bubbles:true,cancelable:true}));
    check(!gear().equipment.weapon,'fresh equipped drag still works');
    check(gear().items.items.filter(item=>item.id==='korgan.starter.short_sword').length===1,'fresh drag preserves one sword instance');
    const invalidDrag=new DataTransfer();invalidDrag.setData('application/x-rotw-item',JSON.stringify({ownerId:'korgan',id:'does-not-exist'}));
    const beforeInvalid=gear();
    document.querySelectorAll('.inventory-cell')[39].dispatchEvent(new DragEvent('drop',{dataTransfer:invalidDrag,bubbles:true,cancelable:true}));
    eq(gear(),beforeInvalid,'stale bag drag ignored without exception or mutation');
    return passed;
  } finally {
    reset();
    for(const [k,value] of originalEntries) {if(value===null)localStorage.removeItem(k);else localStorage.setItem(k,value);}
  }
}
