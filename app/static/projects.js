'use strict';

// Project identity comes from the source API, not from a filename or pasted URL.
function sourceProjects(sources) {
  const bySource = new Map();
  for (const source of sources) {
    bySource.set(source.id, {
      key: source.project_key || 'local:' + source.id,
      label: source.youtube_video_id ? 'YouTube · ' + source.youtube_video_id : source.name
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

function findProjectClips(items, bySource, kind, query) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter(item => {
    if (kind !== 'all' && item.kind !== kind) return false;
    if (!terms.length) return true;
    const label = bySource.get(item.source_id)?.label || '';
    const text = (label + ' ' + (item.clip_title||'') + ' ' + item.name).toLowerCase();
    return terms.every(term => text.includes(term));
  });
}
