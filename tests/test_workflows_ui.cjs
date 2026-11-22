'use strict';
// Focused DOM-contract check for workflow card communication. No live API calls.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const vm = require('node:vm');
class Element {
  constructor(doc){this.doc=doc;this.children=[];this.dataset={};this.textContent='';this.value='';}
  append(...items){for(const item of items)item.parent=this;this.children.push(...items);}
  prepend(...items){for(const item of items)item.parent=this;this.children.unshift(...items);}
  replaceChildren(){if(this.contains(this.doc.activeElement))this.doc.activeElement=null;for(const c of this.children)c.parent=null;this.children.length=0;}
  contains(item){return !!item&&(item===this||this.children.some(x=>x.contains(item)));}
  closest(selector){return (selector==='[data-workflow-key]'&&this.dataset.workflowKey)?this:this.parent?.closest(selector);}
  querySelectorAll(selector){return this.children.flatMap(item=>[...(selector==='[data-workflow-action]'&&item.dataset.workflowAction?[item]:[]),...item.querySelectorAll(selector)]);}
  focus(){this.doc.activeElement=this;}
  setAttribute(key,value){(this.attributes??={})[key]=value;}
  addEventListener(kind, fn){(this.listeners??={})[kind]=fn;}
}
function load(override={}){
  const doc={activeElement:null,createElement:()=>new Element(doc),addEventListener(){},dispatchEvent(){}};
  const elements=new Map(), $=id=>{
    if(!elements.has(id))elements.set(id,new Element(doc));
    return elements.get(id);
  };
  const route={id:"project-workspace",key:"youtube:U8bVUVQMPM8"};
  const sandbox=vm.createContext({
    workspace:{route:()=>route,revision:()=>1,subscribe(){},open(){}},
    $, URL, URLSearchParams, state:{source:null}, document:doc,
    api:()=>new Promise(()=>{}), announce(){}, setInterval(){}, CustomEvent:class {}, ...override
  });
  vm.runInContext(readFileSync(new URL('../app/static/projects.js','file://'+__filename),'utf8'),sandbox);
  vm.runInContext(readFileSync(new URL('../app/static/workflows.js','file://'+__filename),'utf8'),sandbox);
  return {$, doc, route, run:code=>vm.runInContext(code,sandbox)};
}
const flatten = el=>[el.textContent,...el.children.flatMap(flatten)].join(' ');
test('import state, saved chunk count and editor action',()=>{
  const {$,run}=load();
  run("paintIngest([])");
  assert.equal($('project-processing').hidden,true);
  run("paintIngest([{id:'live',kind:'live',status:'running',url:'https://www.youtube.com/watch?v=U8bVUVQMPM8',outputs:[{source_id:'first'}]}])");
  const card=$('ingest-jobs').children[0];
  assert.equal(card.dataset.state,'running');
  assert.match(flatten(card),/Capturing.*1 saved chunk.*Stop capture.*Edit latest chunk/);
  run("paintIngest([{id:'vod',youtube_video_id:'U8bVUVQMPM8',kind:'vod',status:'running',message:'Original saved; building H.264 editing copy'}])");
  assert.match(flatten($('ingest-jobs')),/Preparing editor copy.*Cancel download/);
  const progress=$('ingest-jobs').children[0].children[0].children.find(el=>el.className==='job-progress');
  assert.equal(progress.attributes['aria-label'],'Preparing editor copy for YouTube import');
  assert.equal(progress.attributes.value,undefined);
});
test('import cards display the provided YouTube title as plain text',()=>{
  const {$,run}=load();
  run("paintIngest([{id:'vod',kind:'vod',status:'completed',youtube_title:'GTA <Highlights>',url:'https://www.youtube.com/watch?v=U8bVUVQMPM8'}])");
  const title=$('ingest-jobs').children[0].children[0].children[0].textContent;
  assert.equal(title,'GTA <Highlights>');
});
test('analysis cards distinguish failures from empty successful reviews',()=>{
  const {$,run}=load();
  run("paintAnalysis([{provider:'audio',status:'failed',message:'Could not finish'},{provider:'whisper',status:'completed',captions:[{text:'Example'}]}])");
  const [failed,empty]=$('suggestions').children;
  assert.equal(failed.dataset.state,'failed');
  assert.match(flatten(failed),/Needs attention.*Could not finish/);
  assert.match(flatten(empty),/Ready.*No candidate clips.*Review captions/);
});

test('ingest polling preserves a focused action and never steals outside focus',()=>{
  const {$,doc,run}=load();
  const first=[{id:'abc',youtube_video_id:'U8bVUVQMPM8',kind:'live',status:'running',message:'First poll',outputs:[{source_id:'src'}]}];
  const draw=items=>run('paintIngest('+JSON.stringify(items)+')');
  draw(first);
  const original=$('ingest-jobs').querySelectorAll('[data-workflow-action]').find(x=>x.dataset.workflowAction==='open');
  original.focus();
  draw([{...first[0],message:'Next poll'}]);
  assert.equal(doc.activeElement.dataset.workflowAction,'open');
  assert.notEqual(doc.activeElement,original);
  const external=$('outside');external.focus();
  draw([{...first[0],message:'Third poll'}]);
  assert.equal(doc.activeElement,external);
});
test('suggestion polling follows the same trim when candidates reorder',()=>{
  const {$,doc,run}=load();
  const job={id:'one',provider:'audio',status:'completed',suggestions:[{start:1,end:9},{start:10,end:20}]};
  const draw=j=>run('paintAnalysis(['+JSON.stringify(j)+'])');
  draw(job);
  const selected=$('suggestions').children[1], key=selected.dataset.workflowKey;
  selected.querySelectorAll('[data-workflow-action]')[0].focus();
  draw({...job,suggestions:job.suggestions.toReversed()});
  assert.equal(doc.activeElement.dataset.workflowAction,'load');
  assert.equal(doc.activeElement.closest('[data-workflow-key]').dataset.workflowKey,key);
});

test('VOD and live submit the explicit local-automation choice',async()=>{
  const calls=[], kindId=rows=>'job-'+rows.length;
  const {$}=load({api(path, options){
    if(path==='/api/ingest'&&options?.method==='POST'){
      calls.push(JSON.parse(options.body));
      return Promise.resolve({id:kindId(calls), youtube_video_id:'U8bVUVQMPM8'});
    }
    return new Promise(()=>{});
  }});
  $('ingest-url').value='https://youtu.be/ABCDEFGHIJK';
  for(const kind of ['vod','live'])for(const checked of [false,true]){
    $('ingest-kind').value=kind;
    $('auto-analyze').checked=checked;
    await $('ingest-form').listeners.submit({preventDefault(){}});
  }
  assert.deepEqual(calls.map(({kind,auto_analyze})=>[kind,auto_analyze]),[
    ['vod',false],['vod',true],['live',false],['live',true]
  ]);
});

test('a project only sees its own jobs; Home shows none',()=>{
  const {$,route,run}=load();
  const rows=[{id:'first',kind:'vod',status:'failed',message:'First project',youtube_video_id:'U8bVUVQMPM8'},
    {id:'second',kind:'vod',status:'running',message:'Second project',youtube_video_id:'ABCDEFGHIJK'}];
  const paint=()=>run('paintIngest('+JSON.stringify(rows)+')');
  paint();
  assert.match(flatten($('ingest-jobs')),/First project/);
  assert.doesNotMatch(flatten($('ingest-jobs')),/Second project/);
  route.id='import-workspace';paint();
  assert.equal($('project-processing').hidden,true);
  assert.equal($('ingest-jobs').children.length,0);
});
