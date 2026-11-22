'use strict';

(() => {
  const root = document.getElementById('ai-clipper');
  if (!root) return;

  function element(tag, text, attributes = {}) {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, value);
    return el;
  }
  function label(text, control) {
    const el = element('label', text);
    el.append(control);
    return el;
  }
  function choose(values, attrs) {
    const el = element('select', undefined, attrs);
    for (const [value, text] of values) el.append(new Option(text, value));
    return el;
  }
  function number(value, min, max, extra={}) {
    return element('input', undefined, {class:'number',type:'number',step:'1',value,min,max,...extra});
  }
  function button(text, type='button', cl='lite') {
    return element('button', text, {type,class:cl});
  }
  function clock(input) {
    const parts = input.replace(',','.').split(':').map(Number);
    if (parts.length < 2 || parts.length > 3 || parts.some(n=>!Number.isFinite(n)||n<0) ||
        parts.at(-1)>=60 || parts.length===3&&parts.at(-2)>=60) return NaN;
    return parts.reduce((n,x)=>n*60+x,0);
  }
  function parseCues(text, sourceDuration) {
    if (text.length > 300000) throw new Error('The pasted transcript is too large. Paste a smaller excerpt.');
    const timing = /^\s*((?:\d{2,}:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d{2,}:)?\d{1,2}:\d{2}[.,]\d{1,3})(?:\s+.*)?$/;
    const cues = [];
    let size = 0;
    for (const block of text.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').trim().split(/\n[ \t]*\n+/)) {
      const lines = block.split('\n');
      const header = lines[0].trim();
      if (!header || /^(WEBVTT(?:\s|$)|NOTE(?:\s|$)|STYLE$|REGION$)/.test(header)) continue;
      const position = lines.findIndex(line=>timing.test(line));
      if (position === -1 || position > 1) throw new Error('Each cue needs a start and end timestamp. Separate cues with a blank line.');
      const [,a,b] = lines[position].match(timing);
      const start = clock(a), end = clock(b), cueText = lines.slice(position+1).join(' ').trim();
      if (!(Number.isFinite(start)&&Number.isFinite(end)&&end>start&&end<=sourceDuration+.001))
        throw new Error('A cue has invalid times or extends beyond the selected source.');
      if (!cueText || cueText.length>1000) throw new Error('Every cue needs 1–1,000 characters of text.');
      if (cues.length && start < cues.at(-1).start) throw new Error('Transcript cues must be in source-time order.');
      size += cueText.length;
      if (size>180000 || cues.length>=2400) throw new Error('Use at most 2,400 cues and 180,000 characters of cue text.');
      cues.push({start,end,text:cueText});
    }
    if (!cues.length) throw new Error('Paste a timestamped WebVTT or SRT transcript first.');
    return cues;
  }
  const info = element('p','Choose a source from the source selector above.',{id:'ai-clipper-source-status',class:'hint ai-source-status',role:'status'});
  const status = element('p','Ready to select a transcript.',{id:'ai-ranking-status',class:'hint ai-clipper-status',role:'status'});
  const form = element('form',undefined,{class:'ai-clipper-form'});
  const sourceMode = choose([['whisper','Saved local Whisper transcript'], ['paste','Paste timestamped transcript']],{id:'ai-transcript-mode'});
  const method = choose([['deterministic','Transcript rules (not an AI model)'],['ollama','Ollama (local AI)']],{id:'ai-ranking-method'});
  method.options[1].disabled = true;
  const inputs = element('div',undefined,{class:'ai-form-options'});
  inputs.append(label('Transcript',sourceMode),label('Ranking method',method));
  const whisperPanel = element('div',undefined,{class:'ai-transcript-panel'});
  const whisperSelect = choose([],{id:'ai-whisper-transcript'});
  const language = choose([['english','English'],['hinglish','Hinglish']],{id:'ai-whisper-language'});
  const transcribe = button('Create local transcript');
  const whisperStatus = element('p','',{role:'status',class:'hint'});
  whisperPanel.append(label('Local transcript',whisperSelect), label('Spoken language',language), transcribe, whisperStatus);
  const pastePanel = element('div',undefined,{class:'ai-transcript-panel',hidden:''});
  const textarea = element('textarea',undefined,{id:'ai-transcript-paste',rows:7,maxlength:300000,placeholder:'00:00:00.000 --> 00:00:04.000\nThis is the first cue.\n\n00:00:04.000 --> 00:00:09.000\nThis is the next cue.',spellcheck:'false'});
  pastePanel.append(label('Paste WebVTT or SRT',textarea),element('p','Use source-relative timestamps and separate cues with a blank line.',{class:'hint'}));
  const ranges = element('div',undefined,{class:'ai-form-options'});
  const count = number(5,1,10,{id:'ai-clip-count'}), min = number(12,5,120,{id:'ai-clip-min'}), max = number(45,5,120,{id:'ai-clip-max'});
  ranges.append(label('Maximum suggestions',count),label('Minimum clip (s)',min),label('Maximum clip (s)',max));
  const focus = element('fieldset',undefined,{class:'ai-focus-range'});
  const focusInputs = element('div',undefined,{class:'ai-form-options'});
  const rangeStart = element('input',undefined,{id:'ai-range-start',class:'number',type:'number',min:'0',step:'any',placeholder:'Beginning'});
  const rangeEnd = element('input',undefined,{id:'ai-range-end',class:'number',type:'number',min:'0',step:'any',placeholder:'End of source'});
  focusInputs.append(label('Source start (s)',rangeStart),label('Source end (s)',rangeEnd));
  focus.append(element('legend','Optional focus range'),element('p','Leave blank to analyze the whole source. Times are relative to the original footage.',{class:'hint'}),focusInputs);
  const run = button('Rank transcript','submit','primary');
  const refresh = button('Refresh providers');
  const actions=element('div',undefined,{class:'ai-actions'});
  actions.append(run,refresh);
  form.append(inputs,whisperPanel,pastePanel,focus,ranges,actions);
  const results = element('div',undefined,{class:'ai-candidates'});
  root.append(info,form,status,results);

  let sourceGen=0, queryNeedingRetry=false, transcriptReading=false, rankInProgress=false, newTranscript=false;
  let whisperAvailable=false, configured=false, whisperActive=false;
  function update() {
    const usePaste=sourceMode.value==='paste';
    pastePanel.hidden=!usePaste;
    whisperPanel.hidden=usePaste;
    transcribe.disabled=!state.source||!whisperAvailable||newTranscript||whisperActive;
    whisperSelect.disabled=!whisperSelect.value;
    run.disabled=!state.source||rankInProgress||!configured||(usePaste?!textarea.value.trim():!whisperSelect.value);
  }
  async function providers() {
    refresh.disabled=true;
    const [ranking,whisper]=await Promise.allSettled([api('/api/ai-clipper/providers'),api('/api/analysis/providers')]);
    configured = ranking.status==='fulfilled' && ranking.value?.deterministic?.available===true;
    const local = ranking.status==='fulfilled'?ranking.value?.ollama:null;
    method.options[1].disabled=!local?.available;
    method.options[1].textContent=local?.available?'Ollama (local AI)'+(local.model?' · '+local.model:''):'Ollama (not configured)';
    if (method.selectedOptions[0]?.disabled) method.value='deterministic';
    whisperAvailable=whisper.status==='fulfilled' && whisper.value?.whisper?.available===true;
    if (!configured) status.textContent='Ranking providers could not be loaded. Select Refresh providers to retry.';
    else if (!rankInProgress) status.textContent='Pick a transcript and rank it. Results open as editable trims, not exports.';
    refresh.disabled=false;
    update();
  }
  async function transcripts() {
    if (!state.source) return;
    if (transcriptReading) {queryNeedingRetry=true;return;}
    transcriptReading=true;
    const generation=sourceGen;
    try {
      const rows=await api('/api/analysis?source_id='+encodeURIComponent(state.source.id));
      if (generation!==sourceGen) return;
      const jobs=Array.isArray(rows)?rows.filter(j=>j.provider==='whisper'):[];
      const active=jobs.find(j=>j.status==='queued'||j.status==='running');
      whisperActive=!!active;
      const saved=jobs.filter(j=>j.status==='completed'&&Array.isArray(j.captions)&&j.captions.length);
      const before=whisperSelect.value;
      if (saved.map(j=>j.id).join(',')!==Array.from(whisperSelect.options,o=>o.value).filter(Boolean).join(',')) {
        whisperSelect.replaceChildren();
        if (!saved.length) whisperSelect.append(new Option('No saved transcript',''));
        for (const [i,j] of saved.entries()) {
          const date=Number.isFinite(j.created_at)?new Date(j.created_at*1000).toLocaleString():null;
          whisperSelect.append(new Option((j.language==='hinglish'?'Hinglish':'English')+(date?' · '+date:' · Transcript '+(i+1))+' · '+j.captions.length+' cues',j.id));
        }
        if (saved.some(j=>j.id===before)) whisperSelect.value=before;
      }
      whisperStatus.textContent=active?'Local transcription in progress.':
        saved.length?'Saved local transcripts are ready to rank.':
        jobs.length?'No usable local transcript yet. Review the latest job in Highlights, retry, or paste your own.':
        !whisperAvailable?'Local Whisper is not available in this setup. Paste timestamped captions instead.':
        'Create a local Whisper transcript or paste your own.';
    } catch (_) {
      if(generation===sourceGen) whisperStatus.textContent='Could not check saved transcripts.';
    } finally {
      transcriptReading=false;
      if(queryNeedingRetry){queryNeedingRetry=false;transcripts();}
      update();
    }
  }
  function onSource() {
    ++sourceGen;
    rankInProgress=false;newTranscript=false;whisperActive=false;
    results.replaceChildren();
    whisperSelect.replaceChildren(new Option('No saved transcript',''));
    textarea.value='';
    rangeStart.value='';rangeEnd.value='';
    const duration=state.source?.duration;
    for(const control of [rangeStart,rangeEnd]) {
      if(Number.isFinite(duration))control.setAttribute('max',duration);
      else control.removeAttribute('max');
    }
    info.textContent=state.source?'Active source: '+state.source.name+' · '+Number(state.source.duration).toFixed(2)+'s':'Choose a source from the source selector above.';
    whisperStatus.textContent=state.source?'Checking saved transcripts…':'No source selected.';
    status.textContent=configured?'Pick a transcript and rank it. Nothing exports automatically.':'Checking ranking providers…';
    update();
    transcripts();
  }
  transcribe.addEventListener('click',async()=>{
    const generation=sourceGen,source=state.source;
    if (!source||transcribe.disabled) return;
    newTranscript=true;update();whisperStatus.textContent='Starting local Whisper…';
    try {
      await api('/api/analysis',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        source_id:source.id,provider:'whisper',language:language.value,allow_cloud:false,visual_motion:false,transcript_only:true,
      })});
      if (generation!==sourceGen) return;
      whisperActive=true;
      whisperStatus.textContent='Local transcript queued.';
      await transcripts();
    } catch (error) {
      if (generation===sourceGen) whisperStatus.textContent='Could not start local transcription: '+error.message;
    } finally {
      if (generation===sourceGen) {newTranscript=false;update();}
    }
  });
  function render(result,source,generation) {
    results.replaceChildren();
    if (Array.isArray(result.warnings)) for (const warning of result.warnings) results.append(element('p',String(warning),{class:'hint'}));
    for (const [i,item] of (result.candidates||[]).entries()) {
      const card=element('article',undefined,{class:'surface ai-candidate'});
      const heading=element('h3','Suggestion '+(i+1));
      const title=element('input',undefined,{type:'text',class:'number',maxlength:'100',value:String(item.title||'Suggested clip').slice(0,100)});
      const a=number(Number(item.start.toFixed(3)),0,source.duration,{step:'any'});
      const b=number(Math.min(Number(item.end.toFixed(3)),source.duration),0,source.duration,{step:'any'});
      const controls=element('div',undefined,{class:'ai-form-options'});
      controls.append(label('Title',title),label('Start (s)',a),label('End (s)',b));
      const reason=element('p',String(item.reason||'Review this candidate before exporting.'),{class:'muted'});
      const open=button('Open in Editor');
      const error=element('p','',{class:'hint',role:'status'});
      open.addEventListener('click',()=>{
        if(generation!==sourceGen||String(state.source?.id)!==String(source.id)) return;
        if(state.busy){error.textContent='Wait for the editor’s current task to finish, then open this suggestion.';return;}
        const start=a.valueAsNumber,end=b.valueAsNumber;
        if(!(Number.isFinite(start)&&Number.isFinite(end)&&start>=0&&end>start&&end<=source.duration+.000001&&title.value.trim()&&title.value.trim().length<=100)){
          error.textContent='Enter a title and valid times inside the source.';return;
        }
        error.textContent='';
        document.dispatchEvent(new CustomEvent('sheesh-ai-open',{detail:{source_id:source.id,start,end,title:title.value.trim(),reason:reason.textContent}}));
      });
      card.append(heading,reason);
      if(typeof item.evidence==='string'&&item.evidence)card.append(element('blockquote',item.evidence));
      card.append(controls,open,error);results.append(card);
    }
  }
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    const source=state.source,generation=sourceGen;
    if (!source||run.disabled) return;
    const limits={count:count.valueAsNumber,min_seconds:min.valueAsNumber,max_seconds:max.valueAsNumber};
    if(!Object.values(limits).every(Number.isInteger)||limits.count<1||limits.count>10||limits.min_seconds<5||limits.max_seconds>120||limits.max_seconds<limits.min_seconds){
      status.textContent='Choose 1–10 suggestions and ordered clip durations between 5 and 120 seconds.';return;
    }
    const payload={source_id:source.id,provider:method.value,...limits};
    try {
      const hasStart=rangeStart.value!=='',hasEnd=rangeEnd.value!=='';
      const start=hasStart?rangeStart.valueAsNumber:0,end=hasEnd?rangeEnd.valueAsNumber:source.duration;
      if ((hasStart||hasEnd)&&!(Number.isFinite(start)&&Number.isFinite(end)&&start>=0&&end>start&&end<=source.duration))
        throw new Error('Use an increasing focus range inside the selected source.');
      if(hasStart)payload.range_start=start;
      if(hasEnd)payload.range_end=end;
      if (sourceMode.value==='paste') payload.cues=parseCues(textarea.value,source.duration);
      else payload.transcript_id=whisperSelect.value;
    } catch(error) {status.textContent=error.message;return;}
    rankInProgress=true;update();
    status.textContent=payload.provider==='ollama'?'Ranking with the configured local model…':'Ranking with transcript rules…';
    try {
      const result=await api('/api/ai-clipper/rank',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      if(generation!==sourceGen||String(state.source?.id)!==String(source.id))return;
      render(result,source,generation);
      const n=result.candidates?.length||0;
      status.textContent=n?(result.method_label||'Ranking')+': '+n+' suggestion'+(n===1?'':'s')+'. Review and edit a candidate before opening it.':
        'No suitable clips found. Try another transcript or duration range, or edit manually.';
    } catch(error) {if(generation===sourceGen)status.textContent='Ranking did not finish: '+error.message;}
    finally {if(generation===sourceGen){rankInProgress=false;update();}}
  });
  sourceMode.addEventListener('change',update);
  textarea.addEventListener('input',update);
  refresh.addEventListener('click',()=>{providers().then(transcripts);});
  document.addEventListener('sheesh-source',onSource);
  setInterval(()=>{if(!root.closest('[hidden]')&&state.source&&sourceMode.value==='whisper')transcripts();},4000);
  providers().then(()=>{if(!sourceGen)onSource();else transcripts();});
  update();
})();
