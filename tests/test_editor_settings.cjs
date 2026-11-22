'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup(saved, blockWrites=false) {
  const map = new Map();
  const el = id => {
    if (!map.has(id)) map.set(id,{id,attrs:{},events:{},
      addEventListener(kind,fn){this.events[kind]=fn;},
      getAttribute(k){return this.attrs[k];}, setAttribute(k,v){this.attrs[k]=v;},
      focus(){this.focused=true;}
    });
    return map.get(id);
  };
  const tabs=['trim','frame','captions','export'].map(name=>{
    const t=el('tab-'+name);t.attrs['aria-controls']='panel-'+name;return t;
  });
  el('editor-tabs').querySelectorAll=()=>tabs;
  let cache=saved;
  const ctx=vm.createContext({document:{getElementById:el},localStorage:{
    getItem:()=>cache, setItem:(_,v)=>{if(blockWrites)throw Error();cache=v;}
  }});
  vm.runInContext(fs.readFileSync(new URL('../app/static/editor-settings.js','file://'+__filename),'utf8'),ctx);
  return {el, get:()=>JSON.parse(vm.runInContext('JSON.stringify(editorDefaults.read())',ctx)), cache:()=>cache};
}
test('defaults are validated, persisted per browser and restored to factory values',()=>{
  const x=setup('{"caption":"bold","layout":"unknown"}');
  assert.deepEqual(x.get(),{aspect:'9:16',layout:'fit',caption:'bold',profile:'high'});
  x.el('default-profile').value='compact';
  x.el('defaults-form').events.submit({preventDefault(){}});
  assert.equal(JSON.parse(x.cache()).profile,'compact');
  x.el('reset-defaults').events.click();
  assert.equal(x.get().caption,'clean');
  const blocked=setup('corrupt',true);
  blocked.el('default-caption').value='minimal';
  blocked.el('defaults-form').events.submit({preventDefault(){}});
  assert.equal(blocked.get().caption,'minimal');
  assert.match(blocked.el('default-status').textContent,/this page only/);
});
test('editor tabs move keyboard focus and hide inactive controls without recreating them',()=>{
  const x=setup(null);
  assert.equal(x.el('panel-trim').hidden,false);
  assert.equal(x.el('panel-captions').hidden,true);
  const input=x.el('panel-frame');input.sentinel='unchanged';
  x.el('tab-trim').events.keydown({key:'ArrowRight',preventDefault(){}});
  assert.equal(x.el('tab-trim').tabIndex,-1);
  assert.equal(x.el('tab-frame').focused,true);
  assert.equal(x.el('tab-frame').attrs['aria-selected'],'true');
  assert.equal(input.hidden,false);assert.equal(input.sentinel,'unchanged');
});
