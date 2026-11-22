'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname,'../app/static/ai-clipper-ui.js'),'utf8');
const handlers = new Map(), requests = [], events = [];
class Node {
  constructor(tag, text='', value='') {
    this.tag=tag; this.textContent=text; this.value=value; this.attrs={}; this.handlers={}; this.children=[];
  }
  get options(){return this.children;}
  get selectedOptions(){return this.options.filter(x=>x.value===this.value);}
  get valueAsNumber(){return this.value==='' ? NaN : Number(this.value);}
  append(...nodes){
    this.children.push(...nodes);
    if(this.tag==='select'&&this.children.length&&!this.value)this.value=this.children[0].value;
  }
  replaceChildren(...nodes){this.children=[];if(this.tag==='select')this.value='';this.append(...nodes);}
  setAttribute(name,value){this.attrs[name]=value;if(name==='value')this.value=String(value);}
  removeAttribute(name){delete this.attrs[name];}
  addEventListener(name,fn){this.handlers[name]=fn;}
  closest(){return null;}
}
function find(el, test) {
  if(test(el))return el;
  for(const child of el.children){const hit=find(child,test);if(hit)return hit;}
}
const root = new Node('section');
const state={source:{id:'clip-source',name:'Source',duration:130},busy:false};
const mockCandidate={start:3,end:28,title:'Suggested clip',reason:'Good moment',evidence:'Short quote',score:.90};
const document={
  getElementById:id=>id==='ai-clipper'?root:null, createElement:tag=>new Node(tag),
  addEventListener:(event,fn)=>handlers.set(event,fn),
  dispatchEvent:event=>events.push(event),
};
const api=async (url,init)=> {
  requests.push([url,init?.body&&JSON.parse(init.body)]);
  if(url==='/api/ai-clipper/providers')return {deterministic:{available:true},ollama:{available:false}};
  if(url==='/api/analysis/providers')return {whisper:{available:true}};
  if(url.startsWith('/api/analysis?'))return [{id:'local-caption-id',provider:'whisper',status:'completed',captions:[{start:0,end:3,text:'A test'}]}, {id:'cloud-caption-id',provider:'assemblyai',status:'completed',captions:[{start:1,end:3,text:'Other'}]}];
  if(url==='/api/analysis')return {};
  if(url==='/api/ai-clipper/rank')return {source_id:'clip-source',provider:'deterministic',method_label:'Transcript rules',candidates:[mockCandidate],warnings:[]};
  throw Error('Unexpected URL '+url);
};
const context=vm.createContext({ document,state,api,Option:function(text,value){return new Node('option',text,value);},
  CustomEvent:class {constructor(type,options){this.type=type;this.detail=options.detail;}},
  setInterval(){},console,
});
vm.runInContext(script,context);
const byId=id=>find(root,n=>n.attrs.id===id);
const byText=text=>find(root,n=>n.textContent===text);
const visit=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
  await visit();
  const form=find(root,n=>n.tag==='form'), mode=byId('ai-transcript-mode'), paste=byId('ai-transcript-paste');
  const run=byText('Rank transcript'), transcript=byId('ai-whisper-transcript');
  assert.equal(transcript.options.length,1);
  assert.equal(transcript.value,'local-caption-id');
  assert.equal(byId('ai-ranking-method').options[1].disabled,true);
  assert.equal(run.disabled,false);
  await byText('Create local transcript').handlers.click();
  const transcription = requests.find(([url,body])=>url==='/api/analysis'&&body)[1];
  assert.equal(transcription.provider,'whisper');
  assert.equal(transcription.allow_cloud,false);
  assert.equal(transcription.transcript_only,true);
  await form.handlers.submit({preventDefault(){}});
  let payload=requests.at(-1)[1];
  assert.equal(payload.transcript_id,'local-caption-id');
  assert.equal(payload.provider,'deterministic');
  assert.equal(payload.cues,undefined);
  assert.equal(payload.range_start,undefined);
  assert.equal(payload.range_end,undefined);
  const open=byText('Open in Editor');
  await open.handlers.click();
  assert.equal(events.at(-1).type,'sheesh-ai-open');
  assert.equal(events.at(-1).detail.title,'Suggested clip');
  assert.equal(events.at(-1).detail.start,3);
  assert.equal(events.at(-1).detail.end,28);
  mode.value='paste';mode.handlers.change();
  assert.equal(run.disabled,true);
  paste.value='WEBVTT\n\n00:02.500 --> 00:06.000 align:start\nhello world\n\n02\n00:08.000 --> 00:15.000\nsecond cue';
  paste.handlers.input();
  assert.equal(run.disabled,false);
  await form.handlers.submit({preventDefault(){}});
  payload=requests.at(-1)[1];
  assert.equal(payload.transcript_id,undefined);
  assert.deepEqual(payload.cues,[{start:2.5,end:6,text:'hello world'},{start:8,end:15,text:'second cue'}]);
  const start=byId('ai-range-start'),end=byId('ai-range-end');
  assert.equal(start.attrs.max,130);
  start.value='2';end.value='9';
  await form.handlers.submit({preventDefault(){}});
  assert.equal(requests.at(-1)[1].range_start,2);
  assert.equal(requests.at(-1)[1].range_end,9);
  start.value='';
  await form.handlers.submit({preventDefault(){}});
  assert.equal(requests.at(-1)[1].range_start,undefined);
  assert.equal(requests.at(-1)[1].range_end,9);
  end.value='131';
  let invalidPrior=requests.length;
  await form.handlers.submit({preventDefault(){}});
  assert.equal(requests.length,invalidPrior);
  assert.match(byId('ai-ranking-status').textContent,/focus range/);
  end.value='';
  const prior=requests.length;
  paste.value='Bad transcript';
  await form.handlers.submit({preventDefault(){}});
  assert.equal(requests.length,prior);
  assert.match(byId('ai-ranking-status').textContent,/needs a start and end timestamp/);
  state.source={id:'different',name:'New source',duration:5};handlers.get('sheesh-source')();
  assert.equal(paste.value,'');
  assert.equal(end.value,'');
  assert.equal(end.attrs.max,5);
  assert.equal(byText('Open in Editor'),undefined);
  assert.equal(run.disabled,true);
  console.log('AI Clipper UI passed local transcript, pasted cues, validation, and editor handoff.');
})().catch(error=>{console.error(error);process.exitCode=1;});
