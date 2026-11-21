'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const vm = require('node:vm');
const box = vm.createContext();
vm.runInContext(readFileSync(new URL('../app/static/preview-guides.js','file://'+__filename),'utf8'),box);

test('guides stay inside frame and leave extra space for vertical overlays', ()=>{
  const get=(w,h)=>Array.from(box.guideBounds(w,h));
  const [x,y,w,h]=get(405,720);
  assert.ok(405-x-w>x);
  assert.ok(720-y-h>y);
  assert.deepEqual(get(720,405),[58,32,604,341]);
  assert.deepEqual(get(540,540),[43,43,454,454]);
});

test('guide drawing restores the preview context', ()=>{
  const actions=[];
  const ctx={
    save(){actions.push('save');},setLineDash(d){actions.push(...d);},
    strokeRect(...p){actions.push(p);},restore(){actions.push('restore');}
  };
  box.drawPreviewGuides(ctx,405,720);
  assert.deepEqual(actions, ['save',7,5,[32,65,304,518],[32,65,304,518],'restore']);
});
