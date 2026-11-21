'use strict';
const $ = id => document.getElementById(id);
const video = $('video'), frame = $('frame'), ctx = frame.getContext('2d');
const hasFaceLayout = layout => layout==='split'||layout==='pip';
const faces = ['x','y','w','h'];
const state = { sources: [], source: null, busy: false, draw: false, pointer: null, rect: null, layouts:[], playEdit:false };
const aspects = {'9:16':[405,720],'16:9':[720,405],'1:1':[540,540]};
let loop = 0;
const value = id => $(id).valueAsNumber;
const clamp = (n,min=0,max=1) => Math.max(min,Math.min(max,n));
const fmt = n => {const v = Math.max(0,Math.floor(n || 0)); return String(Math.floor(v/60)).padStart(2,'0') + ':' + String(v%60).padStart(2,'0');};
let noticeTimer;
function announce(text, error=false, persistent=false) {
  const notice=$('notice');
  clearTimeout(noticeTimer);
  notice.textContent=text;
  notice.dataset.error=String(error);
  if(!persistent)noticeTimer=setTimeout(()=>{notice.textContent='';},error?14000:8000);
}
async function api(path, init={}) {
  const res = await fetch(path, init);
  let data;
  try { data = await res.json(); } catch (_) { throw new Error('Server did not return JSON (' + res.status + ').'); }
  if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : (Array.isArray(data.detail) ? data.detail.map(issue=>issue.msg).filter(Boolean).join(' · ') : (typeof data.error === 'string' ? data.error : 'Request failed (' + res.status + ').')));
  return data;
}
function faceRegion() {
  const nums=faces.map(k=>value('face-'+k));
  if(nums.some(n=>!Number.isFinite(n))) return null;
  const [x,y,w,h]=nums;
  if (x<0 || y<0 || w<=0 || h<=0 || x+w>1.000001 || y+h>1.000001) return null;
  return {x,y,w:Math.min(w,1-x),h:Math.min(h,1-y)};
}
function updateExportSummary(duration) {
  const label=$('export-summary');if(!label)return;
  const aspect=$('aspect').value, compact=$('export-profile').value==='compact';
  const short=compact?720:1080, long=compact?1280:1920;
  const size=aspect==='9:16'?[short,long]:aspect==='16:9'?[long,short]:[short,short];
  label.textContent=state.source?size.join(' × ')+' · MP4'+(duration>0?' · '+duration.toFixed(2)+' s':''):'Choose a source to see export settings.';
}
function updateControls() {
  const has=!!state.source, canPlay=has && video.readyState>=2, dur=state.source?.duration||0;
  const a=value('start'), b=value('end'), valid=has&&Number.isFinite(a)&&Number.isFinite(b)&&a>=0&&b>a&&b<=dur+.0001;
  const cuts=readCuts(a,b);
  const length=valid&&cuts?Math.max(0,b-a-cuts.reduce((total,c)=>total+c.end-c.start,0)):0;
  $('clip-length').value=length.toFixed(2)+' s';
  updateExportSummary(length);
  ['play','seek','start-here','end-here','mark-face'].forEach(id=>$(id).disabled=!canPlay);
  const hasRegion=faces.some(k=>$('face-'+k).value!=='');
  const faceValid=!!faceRegion() || (!hasRegion && !hasFaceLayout($('layout').value));
  const layoutValid=state.layouts.every(l=>l.at>a && l.at<b);
  $('draft').disabled=!valid||!faceValid||!cuts||!layoutValid||state.busy; $('export').disabled=!valid||!faceValid||!cuts||!layoutValid||state.busy;
  $('edit-warning').textContent=has&&(!valid?'Use a start and end inside the source duration.':!faceValid?'Choose a complete facecam rectangle within the source.':!cuts?'Removed sections must be separated and strictly inside the trim.':!layoutValid?'Layout changes must be strictly inside the trim.':'')||'';
  $('split-controls').hidden=!hasFaceLayout($('layout').value);
  $('gameplay-share-row').hidden=$('layout').value!=='split';
  $('facecam-first-row').hidden=$('layout').value!=='split';
  $('pip-controls').hidden=$('layout').value!=='pip';
  $('add-cut').disabled=!has;
  $('add-layout').disabled=!canPlay||!valid||!faceValid;
  $('import-button').disabled=state.busy; $('source').disabled=state.busy||state.sources.length===0;
  const t=video.currentTime || 0;
  $('play-time').textContent=fmt(t)+' / '+fmt(dur);
  $('seek').value=String(t);
  $('play').textContent = video.paused ? 'Play' : 'Pause';
  $('play-edit').disabled=!canPlay||!valid||!cuts;
  $('play-edit').textContent=state.playEdit&&!video.paused?'Stop trim':'Play trim';
}
function framing() {
  const facecam=faceRegion();
  const config={layout:$('layout').value,focus_x:value('focus-x'),focus_y:value('focus-y'),
    gameplay_share:value('gameplay-share'),facecam_focus_x:value('facecam-focus-x'),facecam_focus_y:value('facecam-focus-y')};
  if(config.layout==='split')config.facecam_first=$('facecam-first').checked;
  if(config.layout==='pip')Object.assign(config,{facecam_scale:value('facecam-scale'),facecam_pos_x:value('facecam-pos-x'),facecam_pos_y:value('facecam-pos-y')});
  if(facecam)config.facecam=facecam;
  return config;
}
function paintLayoutList(){
  const host=$('layout-changes');host.replaceChildren();
  for(const [i,c] of state.layouts.entries()){
    const row=document.createElement('div');row.className='layout-row';
    const tag=document.createElement('span');tag.textContent=c.at.toFixed(2)+'s · '+c.layout;
    const jump=document.createElement('button');jump.type='button';jump.className='lite';jump.textContent='Jump';
    jump.addEventListener('click',()=>{if(video.readyState>=1)video.currentTime=c.at;paint();});
    const remove=document.createElement('button');remove.type='button';remove.className='lite';remove.textContent='Remove';
    remove.addEventListener('click',()=>{state.layouts.splice(i,1);paintLayoutList();updateControls();paint();});
    row.append(tag,jump,remove);host.append(row);
  }
}
$('add-layout').addEventListener('click',()=>{
  const at=Math.round(video.currentTime*1000)/1000;
  if(!(at>value('start')&&at<value('end'))){announce('Move the playhead inside the clip first.',true);return;}
  const conf=framing();
  if(hasFaceLayout(conf.layout)&&!conf.facecam){announce('This layout needs a facecam rectangle.',true);return;}
  state.layouts=state.layouts.filter(l=>l.at!==at);state.layouts.push({at,...conf});state.layouts.sort((a,b)=>a.at-b.at);
  paintLayoutList();updateControls();paint();announce('Layout captured at '+at.toFixed(2)+'s.');
});
function readCuts(start,end) {
  const cuts=Array.from($('cuts').children,row=>({start:row.querySelector('[data-cut=start]').valueAsNumber,end:row.querySelector('[data-cut=end]').valueAsNumber})).sort((a,b)=>a.start-b.start);
  for(let i=0;i<cuts.length;i++){const c=cuts[i];if(!(c.start>start && c.end>c.start && c.end<end) || (i>0 && c.start<=cuts[i-1].end))return null;}
  return cuts;
}
function addCut(c={}) {
  const row=document.createElement('div');row.className='cut-row';
  for(const key of ['start','end']){
    const label=document.createElement('label');label.textContent=key==='start'?'Remove from (s)':'Remove to (s)';
    const input=document.createElement('input');input.type='number';input.className='number';input.min='0';input.step='.01';input.dataset.cut=key;
    if(c[key]!==undefined)input.value=String(c[key]);label.append(input);row.append(label);
  }
  const remove=document.createElement('button');remove.type='button';remove.className='lite';remove.textContent='Remove row';
  remove.addEventListener('click',()=>{row.remove();updateControls();});row.append(remove);$('cuts').append(row);updateControls();
}
$('add-cut').addEventListener('click',()=>addCut());
function setFace(region) {
  for(const k of faces) $('face-'+k).value = region ? String(Math.round(region[k]*1000)/1000) : '';
  if(region){
    const x=value('face-x'), y=value('face-y');
    $('face-w').value=String(Math.round(Math.min(value('face-w'),1-x)*1000)/1000);
    $('face-h').value=String(Math.round(Math.min(value('face-h'),1-y)*1000)/1000);
  }
}
function modeDraw(on) {
  state.draw=on; state.pointer=null; state.rect=null;
  $('mark-face').textContent=on?'Cancel drawing':'Draw facecam region';
  $('mark-face').setAttribute('aria-pressed',String(on));
  $('viewport').classList.toggle('draw',on);
  paint();
}
function loadSource(id) {
  const hit = state.sources.find(s=>String(s.id)===String(id));
  if(!hit) return;
  state.source = hit;
  state.playEdit=false;
  $('source').value = String(hit.id);
  video.pause();
  video.src=hit.url; video.load();
  $('start').value='0'; $('end').value=String(hit.duration);
  $('cuts').replaceChildren();
  state.layouts=[];paintLayoutList();
  $('facecam-first').checked=false;$('gameplay-share').value='.6666666667';$('facecam-focus-x').value='.5';$('facecam-focus-y').value='.5';$('facecam-scale').value='.28';$('facecam-pos-x').value='.95';$('facecam-pos-y').value='.04';
  for(const k of ['start','end','seek']) $(k).max=String(hit.duration);
  setFace(null); modeDraw(false);
  $('source-meta').textContent = hit.width+' × '+hit.height+' · '+fmt(hit.duration);
  $('empty').hidden = false; $('viewport').hidden=true;
  $('empty').querySelector('b').textContent='Loading preview…';
  $('empty').querySelector('p').textContent='The browser is opening your original file.';
  updateControls();
  document.dispatchEvent(new CustomEvent('sheesh-source',{detail:hit.id}));
}
async function sources(selectId, preserve=false) {
  state.sources=await api('/api/sources');
  $('source').replaceChildren();
  if(!state.sources.length){
    state.source=null;
    $('source').append(new Option('No sources yet',''));
  }
  for(const x of state.sources) $('source').append(new Option(x.name,String(x.id)));
  const desired = selectId ?? state.source?.id ?? state.sources[0]?.id;
  if (desired) {
    if(preserve && state.source && String(state.source.id)===String(desired))$('source').value=String(desired);
    else loadSource(desired);
  }
  updateControls();
  visibleGallery();
}
function safeArtifact(p) {
  try {const u=new URL(p,location.href); return u.origin===location.origin?u.href:null;} catch(_){return null;}
}
let artifactItems=[], artifactRequest=0, lastGalleryView='';
function readableSize(bytes) {
  if(!Number.isFinite(bytes)||bytes<=0)return '';
  return bytes>=1048576?(bytes/1048576).toFixed(1)+' MB':Math.max(1,Math.round(bytes/1024))+' KB';
}
function visibleGallery() {
  const filter=$('artifact-filter')?.value || 'all';
  const selected=artifactItems.filter(item=>filter==='all'||item.kind===filter);
  const sourceNames=new Map(state.sources.map(item=>[item.id,item.name]));
  const key=JSON.stringify([filter,selected,[...sourceNames]]);
  if(key===lastGalleryView)return;
  lastGalleryView=key;
  const host=$('artifacts');host.replaceChildren();
  const count=$('artifact-count');
  if(count)count.textContent=filter==='all'?artifactItems.length+' saved':selected.length+' of '+artifactItems.length+' saved';
  if(!selected.length){
    const p=document.createElement('p');p.className='artifact-empty muted';
    p.textContent=filter==='draft'?'No drafts yet. Analyze a source or save a draft from the editor.':filter==='export'?'No exports yet. Export a finished clip from the editor.':'Your drafts and exports will appear here.';
    host.append(p);return;
  }
  const groups=new Map();
  for(const item of selected) {
    const groupKey=item.source_id||'';
    if(!groups.has(groupKey)) groups.set(groupKey,[]);
    groups.get(groupKey).push(item);
  }
  for(const [sourceId, items] of groups) {
    const group=document.createElement('section');group.className='artifact-group';
    const title=document.createElement('h3');
    title.textContent=sourceNames.get(sourceId)||(sourceId?'Unavailable source · '+sourceId.slice(0,8):'Unlinked clips');
    const summary=document.createElement('p');summary.className='panel-note';
    summary.textContent=items.length+' clip'+(items.length===1?'':'s');
    const tiles=document.createElement('div');tiles.className='artifact-grid';
    group.append(title,summary,tiles);host.append(group);
    for(const item of items) {
      const url=safeArtifact(item.url);if(!url)continue;
      const card=document.createElement('article');card.className='artifact';
      const tag=document.createElement('span');tag.className='tag';tag.textContent=item.kind==='draft'?'Draft':'Export';
      const h=document.createElement('h4');h.textContent=item.name;
      const v=document.createElement('video');v.src=url;v.controls=true;v.preload='none';v.playsInline=true;v.setAttribute('aria-label','Preview '+item.name);card.append(v,tag,h);
      const parts=[item.width&&item.height?item.width+' × '+item.height:'',Number.isFinite(item.duration)?item.duration.toFixed(2)+' s':'',readableSize(item.bytes)].filter(Boolean);
      if(parts.length){const meta=document.createElement('p');meta.className='artifact-meta';meta.textContent=parts.join(' · ');card.append(meta);}
      const a=document.createElement('a');a.href=url;a.download=item.name;a.textContent='Download MP4';
      const restore=document.createElement('button');restore.type='button';restore.className='text-button';
      restore.textContent='Restore edit';restore.addEventListener('click',()=>restoreEdit(item.id,restore));
      const links=document.createElement('div');links.className='artifact-links';links.append(a,restore);
      card.append(links);tiles.append(card);
    }
  }
}
async function artifacts() {
  const request=++artifactRequest;
  const list=await api('/api/artifacts');
  if(request!==artifactRequest)return;
  artifactItems=list;visibleGallery();
}
async function restoreEdit(id,button) {
  if(state.busy)return;
  state.busy=true;button.disabled=true;updateControls();
  const revision=workspace.revision();
  try {
    const item=await api('/api/artifacts/'+encodeURIComponent(id)), edit=item.edit;
    if(!edit)throw new Error('This artifact has no saved edit.');
    if(!state.sources.some(s=>String(s.id)===String(edit.source_id)))await sources(edit.source_id);
    if(!state.sources.some(s=>String(s.id)===String(edit.source_id)))throw new Error('The original source is unavailable.');
    loadSource(edit.source_id);
    for(const key of ['start','end','aspect','layout'])$(key).value=String(edit[key]);
    $('focus-x').value=String(edit.focus_x);$('focus-y').value=String(edit.focus_y);
    $('gameplay-share').value=String(edit.gameplay_share??.6666666667);$('facecam-first').checked=edit.facecam_first===true;
    $('facecam-focus-x').value=String(edit.facecam_focus_x??.5);$('facecam-focus-y').value=String(edit.facecam_focus_y??.5);
    $('facecam-scale').value=String(edit.facecam_scale??.28);$('facecam-pos-x').value=String(edit.facecam_pos_x??.95);$('facecam-pos-y').value=String(edit.facecam_pos_y??.04);
    $('export-profile').value=edit.export_profile||'high';(edit.cuts||[]).forEach(addCut);
    state.layouts=edit.layout_changes||[];paintLayoutList();
    if(state.layouts.length)$('layout-changes').parentElement.open=true;
    if(edit.cuts?.length)$('cuts').parentElement.open=true;
    document.dispatchEvent(new CustomEvent('sheesh-edit-restored',{detail:edit}));
    setFace(edit.facecam||null);paint();
    announce('Edit restored. The saved artifact was not changed.');
    if(workspace.revision()===revision)workspace.open('editor-workspace','preview-title');
  }catch(e){announce(e.message,true);}finally{state.busy=false;button.disabled=false;updateControls();}
}
function drawFit(sx,sy,sw,sh,dx,dy,dw,dh) {
  const f=Math.min(dw/sw,dh/sh), w=sw*f, h=sh*f;
  ctx.drawImage(video,sx,sy,sw,sh,dx+(dw-w)/2,dy+(dh-h)/2,w,h);
  return {x:dx+(dw-w)/2,y:dy+(dh-h)/2,w,h};
}
function drawFill(sx,sy,sw,sh,dx,dy,dw,dh,fx,fy) {
  const scale=Math.max(dw/sw,dh/sh), w=dw/scale, h=dh/scale;
  ctx.drawImage(video,sx+(sw-w)*fx,sy+(sh-h)*fy,w,h,dx,dy,dw,dh);
}
function paint() {
  if(!state.source || video.readyState<2) return;
  const [w,h]=state.draw?[720,Math.max(1,Math.round(720*video.videoHeight/video.videoWidth))]:aspects[$('aspect').value];
  if(frame.width!==w || frame.height!==h){frame.width=w;frame.height=h;}
  const vw=video.videoWidth, vh=video.videoHeight;
  if(!vw || !vh) return;
  ctx.fillStyle='#000';ctx.fillRect(0,0,w,h);
  if(state.draw){
    drawFit(0,0,vw,vh,0,0,w,h);
    const box=state.rect||faceRegion();
    if(box){
      ctx.fillStyle='rgba(191,163,255,.17)'; ctx.fillRect(box.x*w,box.y*h,box.w*w,box.h*h);
      ctx.lineWidth=2;ctx.strokeStyle='#c5a9ff';ctx.strokeRect(box.x*w,box.y*h,box.w*w,box.h*h);
    }
    return;
  }
  const config=($('preview-layouts').checked?state.layouts.findLast(l=>l.at<=video.currentTime):null)||framing();
  const {layout,focus_x:fx,focus_y:fy}=config;
  if(layout==='split' && config.facecam){
    const f=config.facecam;
    const g=config.gameplay_share??2/3, cx=config.facecam_focus_x??.5, cy=config.facecam_focus_y??.5;
    const first=config.facecam_first===true;
    if(w>h){const gw=Math.round(w*g), fw=w-gw;drawFill(0,0,vw,vh,first?fw:0,0,gw,h,fx,fy);drawFill(f.x*vw,f.y*vh,f.w*vw,f.h*vh,first?0:gw,0,fw,h,cx,cy);}
    else {const gh=Math.round(h*g), fh=h-gh;drawFill(0,0,vw,vh,0,first?fh:0,w,gh,fx,fy);drawFill(f.x*vw,f.y*vh,f.w*vw,f.h*vh,0,first?0:gh,w,fh,cx,cy);}
  } else if(layout==='pip' && config.facecam) {
    drawFill(0,0,vw,vh,0,0,w,h,fx,fy);
    const f=config.facecam, fw=w*(config.facecam_scale??.28), fh=fw*9/16;
    const x=(w-fw)*(config.facecam_pos_x??.95),y=(h-fh)*(config.facecam_pos_y??.04);
    drawFill(f.x*vw,f.y*vh,f.w*vw,f.h*vh,x,y,fw,fh,config.facecam_focus_x??.5,config.facecam_focus_y??.5);
  } else if(layout==='fill') drawFill(0,0,vw,vh,0,0,w,h,fx,fy);
  else drawFit(0,0,vw,vh,0,0,w,h);
  const caption={text:''};document.dispatchEvent(new CustomEvent('sheesh-preview',{detail:caption}));
  if(caption.text) {
    const size=Math.round(Math.min(w,h)*.048), max=w*.88;
    ctx.font=`700 ${size}px system-ui, sans-serif`;ctx.textAlign='center';ctx.textBaseline='middle';
    const lines=[];let line='';
    for(const word of caption.text.trim().split(/\s+/)){
      const text=line?line+' '+word:word;
      if(line&&ctx.measureText(text).width>max){lines.push(line);line=word;}else line=text;
    }
    if(line)lines.push(line);
    const shown=lines.slice(0,3), pitch=size*1.28;
    for(const [i,txt] of shown.entries()){
      const y=h-size*1.8-(shown.length-1-i)*pitch;
      const box=Math.min(max,ctx.measureText(txt).width)+size*.7;
      ctx.fillStyle='rgba(0,0,0,.75)';ctx.fillRect((w-box)/2,y-pitch/2,box,pitch);
      ctx.fillStyle='#fff';ctx.fillText(txt,w/2,y,max);
    }
  }
}
function ticking() {
  if(state.playEdit&&!video.paused) {
    const start=value('start'),end=value('end'), cuts=readCuts(start,end),t=video.currentTime;
    if(!cuts||t>=end || !(end>start)){state.playEdit=false;video.pause();}
    else if(t<start && !video.seeking)video.currentTime=start;
    else if(!video.seeking){const cut=cuts.find(c=>t>=c.start&&t<c.end);if(cut)video.currentTime=cut.end;}
  }
  paint(); updateControls();
  cancelAnimationFrame(loop);
  if(!video.paused && !video.ended) loop=requestAnimationFrame(ticking);
}
function point(e) {
  const rect=frame.getBoundingClientRect();
  return {x:clamp((e.clientX-rect.left)/rect.width),y:clamp((e.clientY-rect.top)/rect.height)};
}
frame.addEventListener('pointerdown',e=>{
  if(!state.draw) return;
  e.preventDefault(); frame.setPointerCapture(e.pointerId);state.pointer=point(e);
});
frame.addEventListener('pointermove',e=>{
  if(!state.draw || !state.pointer) return;
  const {x,y}=point(e), p=state.pointer;
  state.rect={x:Math.min(x,p.x),y:Math.min(y,p.y),w:Math.abs(x-p.x),h:Math.abs(y-p.y)};paint();
});
frame.addEventListener('pointerup',()=>{
  if(!state.draw || !state.pointer) return;
  state.pointer=null;
  if(state.rect && state.rect.w>=.01 && state.rect.h>=.01){
    setFace(state.rect);if(!hasFaceLayout($('layout').value))$('layout').value='split';modeDraw(false);updateControls();announce('Facecam region set.');
  }
});
frame.addEventListener('pointercancel',()=>{state.pointer=null;state.rect=null;paint();});
document.addEventListener('keydown',e=>{if(state.draw && e.key==='Escape') modeDraw(false);});
$('mark-face').addEventListener('click',()=>{video.pause();modeDraw(!state.draw);if(state.draw)announce('Drag a rectangle on the source preview, or press Esc to cancel.');else announce('');});
$('clear-face').addEventListener('click',()=>{setFace(null);modeDraw(false);updateControls();announce('Facecam region cleared.');});
$('edit-form').addEventListener('submit',e=>e.preventDefault());
$('edit-form').addEventListener('input',()=>{updateControls();paint();});
$('layout').addEventListener('change',()=>{if(hasFaceLayout($('layout').value)&&!faceRegion())announce('Draw or enter a facecam rectangle to use this layout.');});
video.addEventListener('loadeddata',()=>{$('empty').hidden=true;$('viewport').hidden=false;ticking();});
video.addEventListener('error',()=>{
  if(!state.source)return;
  $('empty').hidden=false;$('viewport').hidden=true;
  $('empty').querySelector('b').textContent='Browser preview unavailable';
  $('empty').querySelector('p').textContent='Try an H.264 MP4. You can still set clip times manually.';
  updateControls();
});
for(const e of ['play','pause','seeked','timeupdate','ended'])video.addEventListener(e,ticking);
$('play').addEventListener('click',()=>{state.playEdit=false;if(video.paused)video.play().catch(()=>announce('This browser cannot play the source file.',true));else video.pause();});
$('play-edit').addEventListener('click',()=>{
  if(state.playEdit&&!video.paused){state.playEdit=false;video.pause();return;}
  const start=value('start');if(!Number.isFinite(start))return;
  state.playEdit=true;video.currentTime=start;video.play().catch(()=>{state.playEdit=false;updateControls();announce('This browser cannot play the source file.',true);});
});
$('seek').addEventListener('input',()=>{state.playEdit=false;video.currentTime=value('seek');updateControls();});
$('start-here').addEventListener('click',()=>{$('start').value=String(Math.min(video.currentTime,state.source.duration).toFixed(2));updateControls();});
$('end-here').addEventListener('click',()=>{$('end').value=String(Math.min(Number(video.currentTime.toFixed(2)),state.source.duration));updateControls();});
$('source').addEventListener('change',()=>loadSource($('source').value));
$('import-button').addEventListener('click',()=>$('import-file').click());
$('import-file').addEventListener('change',async()=>{
  const f=$('import-file').files[0];$('import-file').value='';if(!f||state.busy)return;
  state.busy=true;updateControls();announce('Importing '+f.name+'…',false,true);
  const body=new FormData();body.append('file',f);
  if($('auto-analyze').checked)body.append('auto_analyze','true');
  try{
    const newSource=await api('/api/sources',{method:'POST',body});await sources(newSource.id);
    announce(newSource.analysis_id?'Source imported. Local highlight analysis queued.':newSource.analysis_note?'Source imported. '+newSource.analysis_note:'Source imported.');
  }
  catch(e){announce(e.message,true);} finally{state.busy=false;updateControls();}
});
async function render(kind){
  if(state.busy||!state.source)return;
  const a=value('start'),b=value('end'),face=faceRegion();
  if(!Number.isFinite(a)||!Number.isFinite(b)||a<0||b<=a||b>state.source.duration+.0001){announce('Use start and end times inside the source duration.',true);return;}
  if(hasFaceLayout($('layout').value)&&!face){announce('This layout needs a facecam rectangle.',true);return;}
  const payload={source_id:state.source.id,start:a,end:b,aspect:$('aspect').value,layout:$('layout').value,focus_x:value('focus-x'),focus_y:value('focus-y'),kind};
  const cuts=readCuts(a,b);
  if(!cuts){announce('Removed sections must be inside the trim and cannot overlap.',true);return;}
  if(cuts.length)payload.cuts=cuts;
  if(state.layouts.length)payload.layout_changes=state.layouts;
  if(kind==='export')payload.export_profile=$('export-profile').value;
  if(hasFaceLayout(payload.layout)){payload.facecam_focus_x=value('facecam-focus-x');payload.facecam_focus_y=value('facecam-focus-y');}
  if(payload.layout==='split'){payload.gameplay_share=value('gameplay-share');payload.facecam_first=$('facecam-first').checked;}
  if(payload.layout==='pip'){payload.facecam_scale=value('facecam-scale');payload.facecam_pos_x=value('facecam-pos-x');payload.facecam_pos_y=value('facecam-pos-y');}
  document.dispatchEvent(new CustomEvent('sheesh-render',{detail:payload}));
  if(face)payload.facecam=face;
  state.busy=true;updateControls();announce(kind==='draft'?'Saving draft…':'Rendering clip…',false,true);
  try{
    const saved=await api('/api/render',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const size=readableSize(saved.bytes);
    announce((kind==='draft'?'Draft saved. ':'Export saved. ')+saved.name+(size?' ('+size+')':'')+'. Find it in Saved clips.');
    try{await artifacts();}catch(e){announce('Saved, but the gallery could not refresh. '+e.message,true);}
  }catch(e){announce(e.message,true);}finally{state.busy=false;updateControls();}
}
$('draft').addEventListener('click',()=>render('draft'));$('export').addEventListener('click',()=>render('export'));
$('artifact-filter')?.addEventListener('change',visibleGallery);
$('export-profile').addEventListener('change',updateControls);
$('refresh').addEventListener('click',()=>artifacts().catch(e=>announce(e.message,true)));
Promise.allSettled([sources(),artifacts()]).then(results=>{for(const r of results)if(r.status==='rejected')announce(r.reason.message,true);});
