'use strict';

const activeIngest = new Set(['queued','running','stopping']);
const activeAnalysis = new Set(['queued','running']);
let ingestReading=false, ingestSending=false, ingestFirst=true, analysisSending=false, analysisReading=false;
const knownSources = new Set();
let analysisProviders = null, analysisGeneration=0, analysisJobs=[], activeCaption=null;
let lastAnalysisHash='', lastIngestHash='';
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
  $('auto-analyze-row').hidden=!live;
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
    const newest=ready.at(-1);
    if(newest?.analysis_id)body.querySelector('.row-text').append(node('p','Latest chunk: local highlight analysis queued. Open the source to review.'));
    else if(newest?.analysis_note)body.querySelector('.row-text').append(node('p',newest.analysis_note));
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
  const payload={url,kind};if(kind==='live')payload.auto_analyze=$('auto-analyze').checked;
  try{await post('/api/ingest',payload);announce(kind==='live'?'Live capture queued.':'VOD download queued.');await refreshIngest(true);}
  catch(e){announce(e.message,true);}finally{ingestSending=false;$('ingest-submit').disabled=false;}
});
function analysisControl() {
  const name=$('analysis-provider').value, cloud=name==='assemblyai', available=analysisProviders?.[name]?.available===true;
  $('analysis-consent-row').hidden=!cloud;
  $('analyze').disabled=!state.source||analysisSending||!available||(cloud&&!$('analysis-consent').checked);
}
async function refreshProviders(){
  try{
    analysisProviders=await api('/api/analysis/providers');
    for(const o of $('analysis-provider').options){
      if(!o.dataset.label)o.dataset.label=o.textContent;
      const a=analysisProviders?.[o.value]?.available===true;
      o.disabled=!a;o.textContent=o.dataset.label+(a?'':' · unavailable');
    }
    if($('analysis-provider').selectedOptions[0]?.disabled&&analysisProviders?.audio?.available)$('analysis-provider').value='audio';
  }catch(e){$('analysis-status').textContent='Analysis is unavailable: '+e.message;}
  analysisControl();
}
$('analysis-provider').addEventListener('change',()=>{$('analysis-consent').checked=false;analysisControl();});
$('analysis-consent').addEventListener('change',analysisControl);
function fmtDetail(n) { return Number(n).toFixed(2)+'s'; }
function selectSuggestion(s) {
  if(!state.source||state.busy)return;
  const start=clamp(Number(s.start),0,state.source.duration),end=clamp(Number(s.end),0,state.source.duration);
  if(!(end>start))return;
  $('start').value=String(start);$('end').value=String(end);$('cuts').replaceChildren();
  if(video.readyState>=1)video.currentTime=start;
  updateControls();paint();refreshCaptionView();
  $('edit-title').scrollIntoView({block:'nearest'});
  announce('Suggested trim loaded. Adjust it before saving or exporting.');
}
function paintAnalysis(jobs) {
  const hash=JSON.stringify(jobs);if(hash===lastAnalysisHash)return;lastAnalysisHash=hash;
  const host=$('suggestions');host.replaceChildren();
  for(const j of jobs.slice(0,5)){
    const provider={audio:'Audio signals',whisper:'Local Whisper',assemblyai:'AssemblyAI'}[j.provider]||'Analysis';
    const method=provider+(j.visual_motion?' + motion':'');
    const {body,actions,left}=card(method+' / '+(j.language==='hinglish'?'Hinglish':'English'),j.status,j.message||'');
    if(j.captions?.length)actions.append(button('Review captions',()=>setCaption(j)));
    if(j.status==='completed'&&!j.suggestions?.length)left.append(node('p','No highlights suggested.'));
    host.append(body);
    for(const [i,s] of (j.suggestions||[]).entries()){
      const clip=card('Suggestion '+(i+1)+' · '+fmtDetail(s.start)+' to '+fmtDetail(s.end),'',s.reason||'Candidate for manual review');
      if(Number.isFinite(s.score))clip.left.append(node('p','Ranking score: '+Number(s.score.toFixed(2))+' (not a performance prediction)'));
      clip.actions.append(button('Load trim',()=>selectSuggestion(s)));
      if(s.draft?.id){
        clip.actions.append(button('Restore draft edit',event=>restoreEdit(s.draft.id,event.currentTarget)));
        const url=safeArtifact(s.draft.url);
        if(url){const link=node('a','Play draft','lite');link.href=url;link.target='_blank';link.rel='noopener';clip.actions.append(link);}
      }
      host.append(clip.body);
    }
  }
}
async function refreshAnalysis(report=false){
  if(analysisReading||!state.source)return;analysisReading=true;
  const source=String(state.source.id), gen=analysisGeneration;
  try{
    const jobs=await api('/api/analysis?source_id='+encodeURIComponent(source));
    if(gen!==analysisGeneration||source!==String(state.source?.id))return;
    if(!Array.isArray(jobs))return;
    const previousDrafts=new Set(analysisJobs.flatMap(j=>(j.suggestions||[]).map(s=>s.draft?.id).filter(Boolean)));
    analysisJobs=jobs;
    if(jobs.some(j=>(j.suggestions||[]).some(s=>s.draft?.id&&!previousDrafts.has(s.draft.id))))artifacts().catch(()=>{});
    paintAnalysis(jobs);
    $('analysis-status').textContent=jobs.some(j=>activeAnalysis.has(j.status))?'Analysis is running locally or with the selected provider. You can keep editing.':'Load a suggested trim, then review boundaries and captions before exporting.';
  }catch(e){if(report)$('analysis-status').textContent='Analysis: '+e.message;}
  finally{analysisReading=false;if(gen!==analysisGeneration&&state.source)refreshAnalysis(true);}
}
$('analysis-form').addEventListener('submit',async e=>{
  e.preventDefault();if(analysisSending||!state.source||$('analyze').disabled)return;
  const source_id=state.source.id,provider=$('analysis-provider').value,language=$('analysis-language').value;
  const allow_cloud=provider==='assemblyai'&&$('analysis-consent').checked;
  const visual_motion=$('visual-motion').checked;
  $('analysis-consent').checked=false;analysisSending=true;analysisControl();
  try{await post('/api/analysis',{source_id,provider,language,allow_cloud,visual_motion});announce('Analysis queued.');await refreshAnalysis(true);}
  catch(e){announce(e.message,true);}finally{analysisSending=false;analysisControl();}
});
function setCaption(job, restored=null,enabled=false) {
  const cues=(restored||job?.captions||[]).map(c=>({start:c.start,end:c.end,text:c.text}));
  if(!cues.length){activeCaption=null;refreshCaptionView();return;}
  activeCaption={id:job?.id||null,cues,dirty:!!restored,enabled};
  refreshCaptionView();
}
function includedCues(cues, start,end,cuts) {
  const keep=[];let cursor=start;
  for(const cut of cuts){if(cut.start>cursor)keep.push([cursor,cut.start]);cursor=cut.end;}
  if(end>cursor)keep.push([cursor,end]);
  let shift=0;const result=[];
  for(const [a,b] of keep) {
    for(const c of cues) {
      const s=Math.max(a,Number(c.start)),t=Math.min(b,Number(c.end));
      if(t>s&&String(c.text||'').trim())result.push({start:shift+s-a,end:shift+t-a,text:String(c.text).trim()});
    }
    shift+=b-a;
  }
  return result;
}
function vttTime(seconds){
  const total=Math.max(0,Math.round(seconds*1000));
  return [Math.floor(total/3600000),Math.floor(total/60000)%60,Math.floor(total/1000)%60].map(n=>String(n).padStart(2,'0')).join(':')+'.'+String(total%1000).padStart(3,'0');
}
function downloadCaptions(){
  if(!activeCaption)return;
  const start=value('start'),end=value('end'),cuts=readCuts(start,end);
  if(!cuts||!(end>start)){announce('Fix the trim and inner cuts before downloading captions.',true);return;}
  const cues=includedCues(activeCaption.cues,start,end,cuts);
  if(!cues.length){announce('No captions overlap this trim.',true);return;}
  const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replace(/[\r\n]+/g,' ');
  const content='WEBVTT\n\n'+cues.map(c=>vttTime(c.start)+' --> '+vttTime(c.end)+'\n'+escape(c.text)+'\n').join('\n');
  const url=URL.createObjectURL(new Blob([content],{type:'text/vtt;charset=utf-8'})),a=node('a');
  a.href=url;a.download='sheeshhclipper-captions.vtt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function refreshCaptionView() {
  const host=$('captions');host.hidden=!activeCaption;host.replaceChildren();
  if(!activeCaption)return;
  const current=activeCaption,start=value('start'),end=value('end');
  const actions=node('div',undefined,'caption-actions'), label=node('label','Burn captions into drafts and exports','check-row'), check=node('input');
  check.type='checkbox';check.checked=current.enabled;label.prepend(check);check.addEventListener('change',()=>{current.enabled=check.checked;paint();});
  actions.append(label,button('Download trimmed VTT',downloadCaptions),button('Clear captions',()=>setCaption(null)));
  host.append(actions,node('p','Edit text for cues overlapping the current trim. Use an empty line to omit a cue.','hint'));
  const list=node('div',undefined,'caption-scroll');
  for(const cue of current.cues.filter(c=>c.start<end&&c.end>start)){
    const row=node('label',undefined,'caption-cue'), input=node('input');input.type='text';input.className='number';input.value=cue.text;input.maxLength=500;
    input.addEventListener('input',()=>{cue.text=input.value;current.dirty=true;paint();});
    row.append(node('span',fmtDetail(cue.start)+'–'+fmtDetail(cue.end)),input);list.append(row);
  }
  if(!list.children.length)list.append(node('p','No caption cues overlap this trim.','hint'));
  host.append(list);paint();
}
document.addEventListener('sheesh-source',()=>{
  analysisGeneration++;analysisJobs=[];lastAnalysisHash='';$('suggestions').replaceChildren();setCaption(null);
  $('analysis-consent').checked=false;analysisControl();refreshAnalysis(true);
});
document.addEventListener('sheesh-edit-restored',async e=>{
  const edit=e.detail, generation=analysisGeneration;
  if(!edit.captions_id&&!edit.captions_override?.length)return;
  const existing=analysisJobs.find(j=>j.id===edit.captions_id);
  try{
    const job=existing|| (edit.captions_id ? await api('/api/analysis/'+encodeURIComponent(edit.captions_id)) : null);
    if(generation===analysisGeneration)setCaption(job,edit.captions_override??null,true);
  }catch(error){if(generation===analysisGeneration)announce('Edit restored, but captions are unavailable: '+error.message,true);}
});
document.addEventListener('sheesh-render',e=>{
  if(!activeCaption?.enabled)return;
  if(activeCaption.dirty) {
    const {start,end}=e.detail;
    const cues=activeCaption.cues.filter(c=>String(c.text||'').trim()&&c.start<end&&c.end>start);
    if(cues.length)e.detail.captions_override=cues;
  } else if(activeCaption.id)e.detail.captions_id=activeCaption.id;
});
document.addEventListener('sheesh-preview',e=>{
  if(!activeCaption?.enabled)return;
  const t=video.currentTime,start=value('start'),end=value('end'), cuts=readCuts(start,end)||[];
  if(t<start||t>end||cuts.some(c=>t>=c.start&&t<c.end))return;
  const cue=activeCaption.cues.find(c=>c.start<=t&&c.end>t&&c.text.trim());
  if(cue)e.detail.text=cue.text;
});
for(const id of ['start','end'])$(id).addEventListener('change',refreshCaptionView);
for(const id of ['start-here','end-here'])$(id).addEventListener('click',refreshCaptionView);
refreshProviders();refreshIngest();analysisControl();
setInterval(()=>{if(document.visibilityState!=='hidden'){refreshIngest();refreshAnalysis();}},2500);
