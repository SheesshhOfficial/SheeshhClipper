'use strict';

const activeIngest = new Set(['queued','running','stopping']);
let ingestReading=false, ingestSending=false, ingestFirst=true;
const knownSources = new Set();
let lastIngestHash='';
function node(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
function button(text,handler){const b=node('button',text,'lite');b.type='button';b.addEventListener('click',handler);return b;}
function card(title,status,description) {
  const body=node('article',undefined,'work-card'),left=node('div',undefined,'row-text'),actions=node('div',undefined,'row-actions');
  left.append(node('strong',title)); if(status)left.append(node('span',status,'row-status'));if(description)left.append(node('p',description));
  body.append(left,actions);return {body,actions,left};
}
async function post(path,body) {
  return api(path,{method:'POST',...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
}
function ingestMode(){
  const live=$('ingest-kind').value==='live';
  $('ingest-submit').textContent=live?'Start live capture':'Download VOD';
  $('ingest-url').placeholder=live?'https://www.youtube.com/live/…':'https://www.youtube.com/watch?v=…';
  $('ingest-hint').textContent=live?'Start and stop explicitly. Finished chunks are saved separately, and can be edited while the stream continues.':'Download a video you own or have permission to use. The original stays on this machine.';
}
$('ingest-kind').addEventListener('change',ingestMode);
function paintIngest(jobs) {
  const hash=JSON.stringify(jobs);if(hash===lastIngestHash)return;lastIngestHash=hash;
  const host=$('ingest-jobs');host.replaceChildren();
  for(const j of jobs.slice(0,10)){
    const outputs=j.outputs||[], ready=outputs.filter(o=>o.source_id);
    const title=j.kind==='live'?'Live capture':'VOD';
    const description=[j.message,ready.length?`${ready.length} source${ready.length===1?'':'s'} ready`:''].filter(Boolean).join(' · ');
    const {body,actions}=card(title,j.status,description);
    if(activeIngest.has(j.status)&&j.status!=='stopping')actions.append(button('Stop',async()=>{
      try{await post('/api/ingest/'+encodeURIComponent(j.id)+'/stop');await refreshIngest(true);}catch(e){announce(e.message,true);}
    }));
    if(ready.length)actions.append(button('Open latest source',async()=>{
      try{await sources(ready.at(-1).source_id);$('preview-title').scrollIntoView({block:'nearest'});}catch(e){announce(e.message,true);}
    }));
    host.append(body);
  }
}
async function refreshIngest(report=false){
  if(ingestReading)return;ingestReading=true;
  try{
    const jobs=await api('/api/ingest');
    if(!Array.isArray(jobs))return;
    const visible=jobs.flatMap(j=>(j.outputs||[]).map(o=>o.source_id).filter(Boolean));
    const unseen=visible.some(id=>!knownSources.has(id));
    if(unseen&&!ingestFirst&&!state.busy)await sources(undefined,true);
    if(!state.busy||ingestFirst)visible.forEach(id=>knownSources.add(id));
    ingestFirst=false;
    paintIngest(jobs);
  }catch(e){if(report)announce('Capture: '+e.message,true);}finally{ingestReading=false;}
}
$('ingest-form').addEventListener('submit',async e=>{
  e.preventDefault();if(ingestSending)return;
  const url=$('ingest-url').value.trim(), kind=$('ingest-kind').value;
  let parsed;
  try{parsed=new URL(url);}catch(_){announce('Enter a valid HTTPS YouTube video or livestream link.',true);return;}
  if(parsed.protocol!=='https:'||!['youtube.com','www.youtube.com','m.youtube.com','youtu.be'].includes(parsed.hostname)){announce('Enter a public HTTPS YouTube video or livestream link.',true);return;}
  ingestSending=true;$('ingest-submit').disabled=true;
  try{await post('/api/ingest',{url,kind});announce(kind==='live'?'Live capture queued.':'VOD download queued.');await refreshIngest(true);}
  catch(e){announce(e.message,true);}finally{ingestSending=false;$('ingest-submit').disabled=false;}
});
ingestMode();refreshIngest();setInterval(refreshIngest,1800);
