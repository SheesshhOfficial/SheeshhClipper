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
  const info = element('p','Open a project and choose its footage.',{id:'ai-clipper-source-status',class:'hint ai-source-status',role:'status'});
  const status = element('p','Ready to select a transcript.',{id:'ai-ranking-status',class:'hint ai-clipper-status',role:'status'});
  const form = element('form',undefined,{class:'ai-clipper-form'});
  const sourceMode = choose([['whisper','Local Whisper transcript'], ['paste','Paste timestamped transcript'], ['assemblyai','AssemblyAI transcript (cloud)']],{id:'ai-transcript-mode'});
  const method = choose([['deterministic','Transcript rules (not an AI model)'],['ollama','Ollama (local AI)'],['openrouter','OpenRouter (cloud AI)'],['nvidia','NVIDIA (cloud AI)']],{id:'ai-ranking-method'});
  const rankProviders={ollama:'Ollama (local AI)',openrouter:'OpenRouter (cloud AI)',nvidia:'NVIDIA (cloud AI)'};
  const cloudRank=()=>method.value==='openrouter'||method.value==='nvidia';
  for (const option of Array.from(method.options).slice(1)) option.disabled=true;
  function consent(id) {
    const check=element('input',undefined,{id,type:'checkbox'});
    const copy=element('span','');
    const row=element('label',undefined,{class:'check-row',hidden:''});
    row.append(check,copy);
    return {check,copy,row};
  }
  const rankingConsent=consent('ai-ranking-cloud-consent');
  const transcriptionConsent=consent('ai-transcription-cloud-consent');
  transcriptionConsent.copy.textContent='Send this source’s audio to AssemblyAI to create this transcript (cloud).';
  const inputs = element('div',undefined,{class:'ai-form-options'});
  inputs.append(label('Transcript',sourceMode),label('Ranking method',method));
  const whisperPanel = element('div',undefined,{class:'ai-transcript-panel'});
  const whisperSelect = choose([],{id:'ai-whisper-transcript'});
  const language = choose([['english','English'],['hinglish','Hinglish']],{id:'ai-whisper-language'});
  const transcribe = button('Create local transcript');
  const whisperStatus = element('p','',{role:'status',class:'hint'});
  whisperPanel.append(label('Saved transcript',whisperSelect), label('Spoken language',language), transcriptionConsent.row, transcribe, whisperStatus);
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
  form.append(inputs,whisperPanel,pastePanel,focus,ranges,rankingConsent.row,actions);
  const results = element('div',undefined,{class:'ai-candidates'});
  root.append(info,form,status,results);

  let sourceGen=0, queryNeedingRetry=false, transcriptReading=false, rankInProgress=false, newTranscript=false;
  let transcriptProviders={}, configured=false, whisperActive=false;
  function update() {
    const usePaste=sourceMode.value==='paste';
    pastePanel.hidden=!usePaste;
    whisperPanel.hidden=usePaste;
    const assembly=sourceMode.value==='assemblyai';
    transcribe.textContent=assembly?'Transcribe with AssemblyAI':'Create local transcript';
    transcriptionConsent.row.hidden=!assembly;
    rankingConsent.row.hidden=!cloudRank();
    rankingConsent.copy.textContent=method.value==='openrouter'?
      'Send candidate transcript excerpts, not audio or video, to OpenRouter and its selected model provider for this ranking (cloud).':
      'Send candidate transcript excerpts, not audio or video, to NVIDIA for this ranking (cloud).';
    transcribe.disabled=!state.source||!transcriptProviders[sourceMode.value]?.available||newTranscript||whisperActive||(assembly&&!transcriptionConsent.check.checked);
    whisperSelect.disabled=!whisperSelect.value;
    run.disabled=!state.source||rankInProgress||!configured||method.selectedOptions[0]?.disabled||(cloudRank()&&!rankingConsent.check.checked)||(usePaste?!textarea.value.trim():!whisperSelect.value);
  }
  async function providers() {
    refresh.disabled=true;
    const [ranking,whisper]=await Promise.allSettled([api('/api/ai-clipper/providers'),api('/api/analysis/providers')]);
    configured = ranking.status==='fulfilled' && ranking.value?.deterministic?.available===true;
    for(const option of Array.from(method.options).slice(1)) {
      const info=ranking.status==='fulfilled'?ranking.value?.[option.value]:null, name=rankProviders[option.value];
      option.disabled=!info?.available;
      option.textContent=info?.available?name+(info.model?' · '+info.model:''):name+' · not configured';
    }
    if (method.selectedOptions[0]?.disabled) {method.value='deterministic';rankingConsent.check.checked=false;}
    transcriptProviders=whisper.status==='fulfilled'?whisper.value:{};
    if (!configured) status.textContent='Ranking providers could not be loaded. Select Refresh providers to retry.';
    else if (!rankInProgress) status.textContent='Pick a transcript and rank it. Results open as editable trims, not exports.';
    refresh.disabled=false;
    update();
  }
  async function transcripts() {
    if (!state.source||sourceMode.value==='paste') return;
    if (transcriptReading) {queryNeedingRetry=true;return;}
    transcriptReading=true;
    const generation=sourceGen, provider=sourceMode.value;
    try {
      const rows=await api('/api/analysis?source_id='+encodeURIComponent(state.source.id));
      if (generation!==sourceGen||provider!==sourceMode.value) return;
      const jobs=Array.isArray(rows)?rows.filter(j=>j.provider===provider):[];
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
      whisperStatus.textContent=active?'Transcription in progress.':
        saved.length?'Saved transcripts are ready to rank without sending audio again.':
        jobs.length?'No usable transcript yet. Review the latest job in Highlights, retry, or paste your own.':
        !transcriptProviders[provider]?.available?'This transcription provider is not configured. You can paste timestamped captions instead.':
        provider==='whisper'?'Create a local Whisper transcript or paste your own.':'Create an AssemblyAI transcript only if you want to send this source’s audio.';
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
    transcriptionConsent.check.checked=false;rankingConsent.check.checked=false;
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
    info.textContent=state.source?'Footage: '+(state.source.youtube_title||state.source.name)+' · '+Number(state.source.duration).toFixed(2)+'s':'Open a project and choose its footage.';
    whisperStatus.textContent=state.source?'Checking saved transcripts…':'No source selected.';
    status.textContent=configured?'Pick a transcript and rank it. Nothing exports automatically.':'Checking ranking providers…';
    update();
    transcripts();
  }
  transcribe.addEventListener('click',async()=>{
    const generation=sourceGen,source=state.source;
    if (!source||transcribe.disabled) return;
    const provider=sourceMode.value, allow_cloud=provider==='assemblyai'&&transcriptionConsent.check.checked;
    if(provider==='assemblyai'&&!allow_cloud)return;
    transcriptionConsent.check.checked=false;
    newTranscript=true;update();whisperStatus.textContent=provider==='assemblyai'?'Submitting audio to AssemblyAI…':'Starting local Whisper…';
    try {
      await api('/api/analysis',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        source_id:source.id,provider,language:language.value,allow_cloud,visual_motion:false,transcript_only:true,
      })});
      if (generation!==sourceGen) return;
      if(provider!==sourceMode.value)return;
      whisperActive=true;
      whisperStatus.textContent=provider==='assemblyai'?'AssemblyAI transcript queued.':'Local transcript queued.';
      await transcripts();
    } catch (error) {
      if (generation===sourceGen) whisperStatus.textContent='Could not start transcription: '+error.message;
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
    const allow_cloud=cloudRank()&&rankingConsent.check.checked;
    if(cloudRank()&&!allow_cloud)return;
    const payload={source_id:source.id,provider:method.value,allow_cloud,...limits};
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
    rankingConsent.check.checked=false;
    rankInProgress=true;update();
    status.textContent=payload.allow_cloud?'Ranking excerpts with '+rankProviders[payload.provider]+'…':payload.provider==='ollama'?'Ranking with the configured local model…':'Ranking with transcript rules…';
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
  sourceMode.addEventListener('change',()=>{
    transcriptionConsent.check.checked=false;rankingConsent.check.checked=false;whisperActive=false;
    whisperSelect.replaceChildren(new Option('No saved transcript',''));update();transcripts();
  });
  method.addEventListener('change',()=>{rankingConsent.check.checked=false;update();});
  rankingConsent.check.addEventListener('change',update);
  transcriptionConsent.check.addEventListener('change',update);
  whisperSelect.addEventListener('change',()=>{rankingConsent.check.checked=false;update();});
  textarea.addEventListener('input',()=>{rankingConsent.check.checked=false;update();});
  refresh.addEventListener('click',()=>{providers().then(transcripts);});
  document.addEventListener('sheesh-source',onSource);
  document.addEventListener('sheesh-source-metadata',update);
  setInterval(()=>{if(!root.closest('[hidden]')&&state.source&&sourceMode.value!=='paste')transcripts();},4000);
  providers().then(()=>{if(!sourceGen)onSource();else transcripts();});
  update();
})();
