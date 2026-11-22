'use strict';

// Project navigation deliberately keeps the same editor mounted. Opening a project
// is read-only; picking a source or opening an editing tool changes the active source.
const projectWorkspace = (() => {
  const $p = id => document.getElementById(id);
  const working = new Set(['queued', 'running', 'stopping']);
  const tools = {
    'project-highlights': ['analysis-workspace', 'analysis-title'],
    'project-ai': ['ai-clipper-workspace', 'ai-clipper-title'],
    'project-editor': ['editor-workspace', 'editor-title'],
    'project-saved': ['export-workspace', 'gallery-title'],
  };
  const changesSource = new Set(['analysis-workspace', 'ai-clipper-workspace', 'editor-workspace']);
  const selection = new Map();
  const painted = new WeakMap();
  let jobItems = [], sourcesLoaded = state.sources.length > 0, findingTitleFor = null;

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function plainClick(event) {
    return !event.defaultPrevented && event.button === 0 &&
      !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey;
  }

  function hash(pane, key) {
    return '#' + pane + (key ? '?key=' + encodeURIComponent(key) : '');
  }

  function route() {
    return workspace.route();
  }

  function getProjects() {
    const groups = new Map(), identities = sourceProjects(state.sources);
    for (const source of state.sources) {
      const identity = identities.get(source.id);
      if (!groups.has(identity.key)) groups.set(identity.key, {
        ...identity, sources: [], jobs: [], drafts: 0, exports: 0,
      });
      groups.get(identity.key).sources.push(source);
    }
    for (const item of typeof artifactItems === 'undefined' ? [] : artifactItems) {
      const group = groups.get(identities.get(item.source_id)?.key);
      if (!group) continue;
      if (item.kind === 'draft') group.drafts++;
      if (item.kind === 'export') group.exports++;
    }
    for (const job of jobItems) {
      const key = ingestProjectKey(job);
      if (!key) continue;
      const title = typeof job.youtube_title === 'string' ? job.youtube_title.trim() : '';
      if (!groups.has(key)) {
        if (!working.has(job.status) && job.status !== 'failed' && job.status !== 'stopped') continue;
        groups.set(key, {key, label: title || 'YouTube · ' + key.slice(8), videoId: key.slice(8),
          hasTitle: Boolean(title), sources: [], jobs: [], drafts: 0, exports: 0});
      }
      const group = groups.get(key);
      if (title && !group.hasTitle) {
        group.label = title;
        group.hasTitle = true;
      }
      group.jobs.push(job);
    }
    return groups;
  }

  function status(project) {
    const running = project.jobs.find(job => working.has(job.status));
    if (running) {
      if (running.status === 'queued') return 'Import queued';
      if (running.status === 'stopping') return 'Finishing import';
      if (running.kind === 'live') return 'Capturing live';
      return /editing copy/i.test(running.message || '') ? 'Preparing editor copy' : 'Importing video';
    }
    if (project.sources.length) return 'Ready';
    const terminal = project.jobs.find(job => job.status === 'failed' || job.status === 'stopped');
    if (terminal) return terminal.status === 'stopped' ? 'Stopped' : 'Needs attention';
    return 'Waiting for footage';
  }

  function summary(project) {
    const plural = (count, singular) => count + ' ' + singular + (count === 1 ? '' : 's');
    return [project.videoId ? 'YouTube' : 'Local file',
      plural(project.sources.length, 'source'), plural(project.drafts, 'draft'), plural(project.exports, 'export')].join(' · ');
  }

  function searchMatches(project, query) {
    const all = [project.label, project.videoId, project.videoId ? 'YouTube' : 'Local file',
      status(project), ...project.sources.map(source => source.name)].join(' ').toLowerCase();
    return query.trim().toLowerCase().split(/\s+/).filter(Boolean).every(word => all.includes(word));
  }

  function link(text, pane, focusId, key, className = 'lite') {
    const anchor = node('a', text, className);
    anchor.href = hash(pane, key);
    anchor.dataset.projectFocus = pane + ':' + (key || '');
    anchor.addEventListener('click', event => {
      if (!plainClick(event)) return;
      event.preventDefault();
      workspace.open(pane, focusId, key);
    });
    return anchor;
  }

  function paintHost(host, signature, children) {
    if (!host || painted.get(host) === signature) return;
    const oldFocus = document.activeElement;
    const focusKey = oldFocus && host.contains(oldFocus) ? oldFocus.dataset.projectFocus : null;
    painted.set(host, signature);
    host.replaceChildren(...children());
    if (focusKey) {
      const restored = Array.from(host.querySelectorAll('[data-project-focus]'))
        .find(element => element.dataset.projectFocus === focusKey);
      restored?.focus({preventScroll: true});
    }
  }

  function projectCard(project) {
    const card = node('article', undefined, 'project-card');
    const title = node('h3', project.label, 'project-card-title');
    const state = node('span', status(project), 'project-card-status tag');
    card.dataset.projectKey = project.key;
    card.dataset.projectReady = String(Boolean(project.sources.length));
    const meta = node('p', summary(project), 'project-card-meta panel-note');
    const actions = node('div', undefined, 'project-card-actions');
    actions.append(link('Open project', 'project-workspace', 'project-title', project.key));
    card.append(title, state, meta, actions);
    return card;
  }

  function paintLists(groups) {
    const projects = [...groups.values()];
    const list = $p('project-list'), query = $p('project-search')?.value || '';
    const matches = projects.filter(project => searchMatches(project, query));
    const signature = rows => JSON.stringify(rows.map(project => [
      project.key, project.label, status(project), project.sources.length, project.drafts, project.exports,
    ]));
    paintHost(list, signature(matches) + '|' + query + '|' + sourcesLoaded, () => {
      if (matches.length) return matches.map(projectCard);
      if (query.trim()) return [node('p', 'No projects match your search.', 'hint project-empty')];
      if (!sourcesLoaded) return [node('p', 'Loading saved projects…', 'hint project-empty')];
      return [node('p', 'No projects yet. Import footage to create your first project.', 'hint project-empty'),
        link('Import footage', 'import-workspace', 'ingest-title', null)];
    });
    const recent = projects.filter(project => project.sources.length).slice(0, 3);
    paintHost($p('recent-project-list'), signature(recent) + '|' + sourcesLoaded, () => recent.length
      ? recent.map(projectCard)
      : [node('p', sourcesLoaded ? 'Your three most recent projects will appear here.' : 'Loading projects…', 'hint project-empty')]);
  }

  function activeSibling(project) {
    return project.sources.find(source => String(source.id) === String(state.source?.id));
  }

  function pickSource(project) {
    return activeSibling(project) ||
      project.sources.find(source => source.id === selection.get(project.key)) || project.sources[0];
  }

  function useSource(project, source, report = true) {
    if (!project || !source) return false;
    if (String(state.source?.id) === String(source.id)) {
      selection.set(project.key, source.id);
      return true;
    }
    if (state.busy) {
      if (report) announce('Wait for the current editor action to finish before switching footage.');
      return false;
    }
    selection.set(project.key, source.id);
    loadSource(source.id);
    return String(state.source?.id) === String(source.id);
  }

  function durationText(duration) {
    if (!Number.isFinite(duration) || duration <= 0) return '';
    const whole = Math.floor(duration), hours = Math.floor(whole / 3600);
    const minutes = Math.floor(whole / 60) % 60, seconds = String(whole % 60).padStart(2, '0');
    return hours ? hours + ':' + String(minutes).padStart(2, '0') + ':' + seconds : minutes + ':' + seconds;
  }

  function sourceRows(project) {
    const labels = new Map(), counts = new Map();
    if (project.videoId) {
      for (const source of project.sources) {
        const name = /^YouTube-[A-Za-z0-9_-]{11}-([a-f0-9]{8})-(.+)$/.exec(source.name);
        if (!name) continue;
        const chunk = /^chunk-(\d+)\.mp4$/.exec(name[2]);
        const label = chunk ? 'Live chunk ' + Number(chunk[1]) : 'YouTube video';
        labels.set(source.id, {label, jobId: name[1]});
        counts.set(label, (counts.get(label) || 0) + 1);
      }
    }
    const selected = pickSource(project);
    const listHost = ['UL', 'OL'].includes($p('project-sources').tagName);
    return project.sources.map(source => {
      const row = node(listHost ? 'li' : 'article', undefined, 'project-source');
      const text = node('div', undefined, 'project-source-label');
      const entry = labels.get(source.id);
      const label = entry ? entry.label + (counts.get(entry.label) > 1 ? ' · ' + entry.jobId : '') : source.name;
      text.append(node('strong', label));
      const meta = [Number.isFinite(source.width) && Number.isFinite(source.height)
        ? source.width + ' × ' + source.height : '', durationText(source.duration)].filter(Boolean).join(' · ');
      if (meta) text.append(node('p', meta, 'panel-note'));
      const selectedRow = selected?.id === source.id;
      const action = node('button', selectedRow ? 'Selected' : 'Select footage', 'lite');
      action.type = 'button';
      action.dataset.projectFocus = 'source:' + source.id;
      action.setAttribute('aria-pressed', String(selectedRow));
      if (selectedRow) row.dataset.selected = 'true';
      action.addEventListener('click', () => {
        if (useSource(project, source)) paint();
      });
      row.append(text, action);
      return row;
    });
  }

  function paintDetail(project) {
    const title = $p('project-title'), detail = $p('project-summary'), host = $p('project-sources');
    if (title) title.textContent = project?.label || (sourcesLoaded ? 'Project unavailable' : 'Loading project…');
    if (detail) detail.textContent = project ? summary(project) + ' · ' + status(project)
      : sourcesLoaded ? 'This project is no longer available. Return to My Projects to choose another.' : '';
    for (const [id, [pane]] of Object.entries(tools)) {
      const control = $p(id);
      if (!control) continue;
      const enabled = Boolean(project?.sources.length);
      control.disabled = !enabled;
      control.setAttribute('aria-disabled', String(!enabled));
      if (control.tagName === 'A') {
        if (enabled) control.href = hash(pane, project.key);
        else control.removeAttribute('href');
      }
    }
    if (host) {
      const activeId = project && activeSibling(project)?.id;
      const pending = project?.jobs.find(job => working.has(job.status));
      const signature = JSON.stringify([project?.key, project?.label, project?.sources, activeId,
        statusIfKnown(project), pending?.message, sourcesLoaded]);
      paintHost(host, signature, () => {
        if (project?.sources.length) return sourceRows(project);
        if (!project) return [];
        return [node(['UL', 'OL'].includes(host.tagName) ? 'li' : 'p',
          pending ? 'Footage will appear here as soon as it is ready.'
                  : 'No footage was saved for this project.', 'hint project-empty')];
      });
    }
    const find = $p('project-fetch-title');
    if (find) {
      find.hidden = !project?.videoId || project.hasTitle || !project.sources.length;
      find.disabled = Boolean(findingTitleFor);
    }
  }

  function statusIfKnown(project) {
    return project ? status(project) : null;
  }

  function paint() {
    const groups = getProjects();
    paintLists(groups);
    const current = route();
    if (current.id === 'project-workspace') paintDetail(groups.get(current.key));
  }

  function syncRoute(next = route()) {
    if (next.key && changesSource.has(next.id) && sourcesLoaded) {
      const project = getProjects().get(next.key);
      if (!project || !useSource(project, pickSource(project), false)) {
        workspace.replace('project-workspace','project-title',next.key);
        return;
      }
    }
    paint();
  }

  function open(key) {
    workspace.open('project-workspace', 'project-title', key);
  }

  for (const [id, [pane, focusId]] of Object.entries(tools)) {
    $p(id)?.addEventListener('click', event => {
      const project = getProjects().get(route().key);
      if (!project?.sources.length) { event.preventDefault(); return; }
      if (event.currentTarget.tagName === 'A' && !plainClick(event)) return;
      event.preventDefault();
      if (changesSource.has(pane) && !useSource(project, pickSource(project))) return;
      workspace.open(pane, focusId, project.key);
    }, {capture: true});
  }

  $p('project-fetch-title')?.addEventListener('click', async event => {
    const button = event.currentTarget, project = getProjects().get(route().key);
    if (findingTitleFor || button.hidden || !project) return;
    const source = pickSource(project);
    if (!source) return;
    findingTitleFor = project.key;
    button.disabled = true;
    try {
      await fetchYouTubeTitle(source.id);
    } catch (error) {
      announce(error?.message || 'Could not look up the YouTube title.', true);
    } finally {
      findingTitleFor = null;
      paint();
      if (button.hidden && route().key === project.key &&
          (document.activeElement === button || document.activeElement === document.body)) {
        $p('project-title')?.focus({preventScroll:true});
      }
    }
  });

  $p('project-search')?.addEventListener('input', paint);
  document.addEventListener('sheesh-sources-updated', () => { sourcesLoaded = true; syncRoute(); });
  document.addEventListener('sheesh-source', paint);
  document.addEventListener('sheesh-source-metadata', paint);
  document.addEventListener('sheesh-artifacts-updated', paint);
  document.addEventListener('sheesh-ingest-updated', event => {
    if (Array.isArray(event.detail)) jobItems = event.detail;
    paint();
  });
  workspace.subscribe(syncRoute);
  syncRoute();
  return {refresh: paint, open, projects: getProjects, currentKey: () => route().key,
    galleryKey: () => route().id === 'export-workspace' ? route().key : null};
})();
