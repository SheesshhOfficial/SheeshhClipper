'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const vm = require('node:vm');

const VIDEO = 'U8bVUVQMPM8', OTHER = 'aaaaaaaaaaa';
const key = 'youtube:' + VIDEO, otherKey = 'youtube:' + OTHER;
const you = (id, name, title = 'Night race') => ({
  id, name: 'YouTube-' + VIDEO + '-' + name, project_key: key, youtube_video_id: VIDEO,
  youtube_title: title, duration: 75, width: 1280, height: 720,
});
const local = id => ({id, name:'Same filename.mp4', duration:35, width:640, height:480});
const assets = () => [you('vod','11111111-video.mp4'), you('chunk','22222222-chunk-00000001.mp4'),
  local('one'), local('two')];

function boot({sources = [], source = null, artifacts = [], route = {id:'projects-workspace',key:null}} = {}) {
  const handlers = new Map(), nav = [], loads = [], messages = [], fetches = [], listeners = [];
  const metadata = new Map();
  const state = {sources, source, busy:false, editVersion:'unchanged'};
  let current = {...route}, document;
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.dataset = {};
      this.attrs = {};
      this.handlers = new Map();
      this.hidden = false;
      this.value = '';
      this.content = '';
    }
    append(...items){ this.children.push(...items); }
    replaceChildren(...items){
      if (this.contains(document.activeElement)) document.activeElement=document.body;
      this.children=items;
    }
    get textContent(){ return this.content+this.children.map(el=>el.textContent).join(''); }
    set textContent(value){ this.content=value;this.children=[]; }
    contains(target){ return this === target || this.children.some(el=>el.contains(target)); }
    querySelectorAll(){
      return this.children.flatMap(el=>[...(el.dataset.projectFocus?[el]:[]),...el.querySelectorAll()]);
    }
    focus(){ document.activeElement=this; }
    setAttribute(key,value){ this.attrs[key]=value; }
    removeAttribute(key){ delete this.attrs[key];if(key==='href') delete this.href; }
    addEventListener(name, fn){ this.handlers.set(name,fn); }
    click(extra = {}){
      let prevented = false;
      const event = {currentTarget:this,button:0,preventDefault(){prevented=true;},...extra};
      const result=this.handlers.get('click')?.(event);
      return {prevented,result};
    }
    change(name){ this.handlers.get(name)?.({currentTarget:this}); }
  }
  const ids = [
    'project-list','project-search','recent-project-list','project-title','project-summary','project-sources',
    'project-highlights','project-ai','project-editor','project-saved','project-fetch-title',
  ];
  const $ = Object.fromEntries(ids.map(id=>[id,new Element(
    ['project-highlights','project-ai','project-editor','project-saved'].includes(id)?'a'
      : id==='project-sources'?'ul':'div',
  )]));
  document = {
    body:new Element('body'), activeElement:null,
    getElementById:id=>$[id],createElement:tag=>new Element(tag),
    addEventListener(name,fn){
      if(!handlers.has(name)) handlers.set(name,[]);
      handlers.get(name).push(fn);
    },
  };
  document.activeElement=document.body;
  const emit=(name,detail)=>{for(const fn of handlers.get(name) || [])fn({detail});};
  const visit=(id,key)=>{current={id,key};for(const fn of listeners)fn({...current});};
  const ctx=vm.createContext({
    document, state, artifactItems:artifacts,
    workspace:{
      route(){return {...current};},
      open(id,focusId,key){ nav.push({id,focusId,key});visit(id,key); },
      subscribe(fn){ listeners.push(fn); },
    },
    loadSource(id){
      loads.push(id);
      state.source=state.sources.find(row=>row.id===id);
      state.editVersion='changed for '+id;
      emit('sheesh-source',id);
    },
    announce(...args){ messages.push(args); },
    async fetchYouTubeTitle(id) {
      fetches.push(id);
      const selected=state.sources.find(row=>row.id===id);
      const title=metadata.get(selected.youtube_video_id);
      for(const row of state.sources) if(row.youtube_video_id===selected.youtube_video_id) row.youtube_title=title;
      emit('sheesh-source-metadata');
    },
  });
  for (const name of ['projects','project-workspace']) {
    vm.runInContext(readFileSync(new URL('../app/static/'+name+'.js','file://'+__filename),'utf8'),ctx);
  }
  return {$, state, nav, loads, messages, fetches, metadata, document, visit, emit,
    controller:vm.runInContext('projectWorkspace',ctx)};
}

test('project library groups by identity, includes unused sources, counts saves, and searches by words', () => {
  const b=boot({sources:assets(),artifacts:[
    {source_id:'vod',kind:'draft'},{source_id:'chunk',kind:'export'},{source_id:'one',kind:'draft'},{kind:'draft'},
  ]});
  assert.deepEqual(b.$['project-list'].children.map(x=>x.dataset.projectKey),[key,'local:one','local:two']);
  assert.match(b.$['project-list'].children[0].textContent,/Night race.*2 sources.*1 draft.*1 export/);
  assert.match(b.$['project-list'].children[2].textContent,/0 drafts.*0 exports/);
  assert.equal(b.$['recent-project-list'].children.length,3);
  const search=b.$['project-search'];
  search.value='  NIGHT   u8bvuvqmpm8 ';search.change('input');
  const card=b.$['project-list'].children[0], open=card.children[3].children[0];
  assert.equal(open.href,'#project-workspace?key=youtube%3AU8bVUVQMPM8');
  assert.equal(open.click({ctrlKey:true}).prevented,false);
  assert.equal(open.click().prevented,true);
  assert.deepEqual(b.nav,[{id:'project-workspace',focusId:'project-title',key}]);
  assert.match(b.$['project-title'].textContent,/Night race/);
  assert.deepEqual(b.loads,[]);
  search.value='does not exist';search.change('input');
  assert.match(b.$['project-list'].textContent,/No projects match/);
});

test('source choices preserve same-source trim, scope all tools, and block a switch while rendering', () => {
  const sources=assets(),b=boot({sources,source:sources[1],route:{id:'project-workspace',key}});
  assert.match(b.$['project-sources'].children[1].textContent,/Live chunk 1.*Selected/);
  b.$['project-editor'].click();
  assert.deepEqual(b.nav.at(-1),{id:'editor-workspace',focusId:'editor-title',key});
  assert.deepEqual(b.loads,[]);
  assert.equal(b.state.editVersion,'unchanged');

  b.visit('project-workspace',key);
  const choose=b.$['project-sources'].children[0].children[1];
  choose.focus();
  choose.click();
  assert.deepEqual(b.loads,['vod']);
  assert.equal(b.document.activeElement.dataset.projectFocus,'source:vod');
  assert.equal(b.document.activeElement.textContent,'Selected');
  b.$['project-highlights'].click();
  assert.equal(b.nav.at(-1).id,'analysis-workspace');
  b.visit('project-workspace',key);
  b.$['project-ai'].click();
  assert.equal(b.nav.at(-1).id,'ai-clipper-workspace');
  assert.deepEqual(b.loads,['vod']);

  b.visit('project-workspace','local:one');
  b.state.busy=true;
  b.$['project-editor'].click();
  assert.equal(b.nav.at(-1).id,'ai-clipper-workspace');
  assert.match(b.messages[0][0],/Wait for the current editor action/);
  b.$['project-saved'].click();
  assert.deepEqual(b.nav.at(-1),{id:'export-workspace',focusId:'gallery-title',key:'local:one'});
  assert.equal(b.controller.galleryKey(),'local:one');
  assert.deepEqual(b.loads,['vod']);
});

test('pending, failed and stopped imports stay project rows without duplicating ready sources', () => {
  const sources=assets(),b=boot({sources,source:sources[0]});
  const untrusted={id:'nope',url:'https://www.youtube.com.evil/watch?v=bbbbbbbbbbb',status:'queued'};
  const pending={id:'p',youtube_video_id:OTHER,kind:'live',status:'running'};
  const ready={id:'q',youtube_video_id:VIDEO,kind:'vod',status:'completed'};
  b.emit('sheesh-ingest-updated',[pending,ready,untrusted]);
  assert.deepEqual(b.$['project-list'].children.map(x=>x.dataset.projectKey),[key,'local:one','local:two',otherKey]);
  assert.equal(b.$['project-list'].children[3].dataset.projectReady,'false');
  b.controller.open(otherKey);
  assert.match(b.$['project-summary'].textContent,/0 sources.*Capturing live/);
  assert.match(b.$['project-sources'].textContent,/as soon as it is ready/);
  assert.equal(b.$['project-editor'].attrs['aria-disabled'],'true');
  assert.deepEqual(b.loads,[]);

  for (const [state, label] of [['stopped','Stopped'],['failed','Needs attention']]){
    b.emit('sheesh-ingest-updated',[{...pending,status:state},ready]);
    assert.match(b.$['project-summary'].textContent,new RegExp(label));
    assert.equal(b.controller.currentKey(),otherKey);
  }
  b.state.sources.push({id:'arrived',name:'imported',project_key:otherKey,youtube_video_id:OTHER,duration:10});
  b.emit('sheesh-sources-updated');
  assert.match(b.$['project-summary'].textContent,/1 source.*Ready/);
  assert.equal(b.$['project-list'].children.filter(x=>x.dataset.projectKey===otherKey).length,1);
  assert.equal(b.$['project-editor'].attrs['aria-disabled'],'false');
});

test('reloading a scoped tool waits for project sources, then keeps the edit on future refresh', () => {
  const b=boot({route:{id:'editor-workspace',key}});
  assert.deepEqual(b.loads,[]);
  b.state.sources=assets();
  b.state.source=b.state.sources[2];
  b.emit('sheesh-sources-updated');
  assert.deepEqual(b.loads,['vod']);
  b.state.editVersion='custom trim';
  b.emit('sheesh-sources-updated');
  assert.deepEqual(b.loads,['vod']);
  assert.equal(b.state.editVersion,'custom trim');
  b.visit('project-workspace','local:two');
  assert.deepEqual(b.loads,['vod']);
  b.visit('analysis-workspace','local:two');
  assert.deepEqual(b.loads,['vod','two']);
});

test('title lookup is explicit, improves sibling project label, and does not reset the current edit', async () => {
  const sources=[you('vod','11111111-video.mp4',''),you('chunk','22222222-chunk-00000001.mp4','')];
  const b=boot({sources,source:sources[1],route:{id:'project-workspace',key}});
  const lookup=b.$['project-fetch-title'];
  assert.equal(lookup.hidden,false);
  assert.match(b.$['project-title'].textContent,/YouTube · U8bVUVQMPM8/);
  b.metadata.set(VIDEO,'Actual game title');
  lookup.focus();
  await lookup.click().result;
  assert.deepEqual(b.fetches,['chunk']);
  assert.deepEqual(b.loads,[]);
  assert.equal(lookup.hidden,true);
  assert.equal(b.document.activeElement,b.$['project-title']);
  assert.equal(b.$['project-title'].textContent,'Actual game title');
  assert.match(b.$['project-list'].textContent,/Actual game title/);
});
