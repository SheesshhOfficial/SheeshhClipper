'use strict';

// Project identity comes from the source API, not from a filename or pasted URL.
function ingestProjectKey(job) {
  const id = typeof job.youtube_video_id==='string' && /^[A-Za-z0-9_-]{11}$/.test(job.youtube_video_id)
    ? job.youtube_video_id : /^https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})$/.exec(job.url || '')?.[1];
  return id ? 'youtube:' + id : null;
}

function sourceProjects(sources) {
  const titles = new Map();
  for (const source of sources) {
    const title = typeof source.youtube_title === 'string' && source.youtube_title.trim();
    if (source.youtube_video_id && source.project_key && title && !titles.has(source.project_key)) {
      titles.set(source.project_key, title);
    }
  }
  const bySource = new Map();
  for (const source of sources) {
    const label = titles.get(source.project_key);
    bySource.set(source.id, {
      key: source.project_key || 'local:' + source.id,
      label: source.youtube_video_id ? label || 'YouTube · ' + source.youtube_video_id : source.name,
      videoId: source.youtube_video_id,
      hasTitle: Boolean(source.youtube_video_id && label)
    });
  }
  return bySource;
}

function collectProjects(items, bySource) {
  const groups = new Map();
  for (const item of items) {
    const id = item.source_id;
    const project = bySource.get(id) || (id
      ? {key:'missing:'+id, label:'Unavailable source · '+id.slice(0, 8)}
      : {key:'unlinked', label:'Unlinked clips'});
    if (!groups.has(project.key)) groups.set(project.key, {...project, items:[]});
    groups.get(project.key).items.push(item);
  }
  return [...groups.values()];
}

function sourceOptionLabels(sources, projects) {
  const labels = new Map(), partsById = new Map(), counts = new Map();
  for (const source of sources) {
    const project = projects.get(source.id);
    if (!project?.hasTitle) {labels.set(source.id, source.name); continue;}
    const parts = /^YouTube-[A-Za-z0-9_-]{11}-([a-f0-9]{8})-(.+)$/.exec(source.name);
    if (!parts) {labels.set(source.id,project.label); continue;}
    const chunk = /^chunk-(\d+)\.mp4$/.exec(parts[2]);
    const detail = chunk ? 'Chunk ' + Number(chunk[1]) : 'VOD';
    const key = project.key + ':' + detail;
    partsById.set(source.id,{title:project.label,key,detail,chunk,job:parts[1]});
    counts.set(key,(counts.get(key)||0)+1);
  }
  for (const [id,part] of partsById) {
    const repeat=counts.get(part.key)>1;
    labels.set(id,part.title + (part.chunk || repeat ? ' · ' + part.detail : '') +
      (repeat ? ' (' + part.job + ')' : ''));
  }
  return labels;
}

function findProjectClips(items, bySource, kind, query) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter(item => {
    if (kind !== 'all' && item.kind !== kind) return false;
    if (!terms.length) return true;
    const project = bySource.get(item.source_id);
    const text = [project?.label, project?.videoId, item.clip_title, item.name].join(' ').toLowerCase();
    return terms.every(term => text.includes(term));
  });
}
