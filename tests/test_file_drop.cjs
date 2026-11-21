'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext();
vm.runInContext(readFileSync(new URL('../app/static/file-drop.js','file://'+__filename),'utf8'),context);

test('only a single MP4 from an explicit file drop is passed to the importer', ()=>{
  const handlers = {}, imported = [], errors = [], classes = new Set();
  const zone = {
    addEventListener(type,fn){handlers[type]=fn;},
    classList:{add: c=>classes.add(c),remove: c=>classes.delete(c)},
    contains: node=>node==='child'
  };
  context.attachLocalFileDrop(zone, f=>imported.push(f.name), e=>errors.push(e));
  function drag(type, types, names, relatedTarget) {
    const e={dataTransfer:{types,files:names.map(name=>({name}))},relatedTarget,
      preventDefault(){this.prevented=true;}};
    handlers[type](e);
    return e;
  }
  assert.equal(drag('drop',['text/plain'],[]).prevented,undefined);
  assert.equal(drag('dragover',['Files'],[]).dataTransfer.dropEffect,'copy');
  assert.equal(classes.has('drag-over'),true);
  drag('dragleave',[],[],'child');
  assert.equal(classes.has('drag-over'),true);
  drag('dragleave',[],[],null);
  assert.equal(classes.has('drag-over'),false);
  assert.equal(drag('drop',['Files'],['clip.MP4']).prevented,true);
  assert.deepEqual(imported,['clip.MP4']);
  drag('drop',['Files'],['clip.webm']);
  drag('drop',['Files'],['one.mp4','two.mp4']);
  drag('drop',['Files'],[]);
  assert.equal(errors.length,3);
});
