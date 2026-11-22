'use strict';

// Keep a single editor and its unsaved state mounted while switching views.
const workspace = (() => {
  const panes = new Map(Array.from(document.querySelectorAll('.workspace-pane'), pane => [pane.id, pane]));
  const links = Array.from(document.querySelectorAll('[data-workspace-link]'));
  const main = document.getElementById('workspace');
  const defaultId = 'import-workspace';
  let current = null;
  let currentKey = null;
  let revision = 0;
  const listeners = new Set();
  const projectPanes = new Set(['project-workspace','analysis-workspace','ai-clipper-workspace','editor-workspace','export-workspace']);

  function parse(hash) {
    const [id, query] = hash.slice(1).split('?',2);
    const key = new URLSearchParams(query || '').get('key');
    return {id, key:key && key.length<=160 ? key : null};
  }

  function show(id, focusId, key = null) {
    if (!panes.has(id)) id = defaultId;
    if (!projectPanes.has(id)) key=null;
    const previous = current;
    const changed=previous!==id || currentKey!==key;
    if (changed) {
      current = id;
      currentKey = key;
      revision++;
      if (previous && previous!==id) {
        for (const media of panes.get(previous).querySelectorAll('video')) {
          if (!media.paused) media.pause();
        }
      }
    }
    for (const [key, pane] of panes) pane.hidden = key !== id;
    const currentNav=key&&projectPanes.has(id)&&panes.has('projects-workspace')?'projects-workspace':id;
    for (const link of links) {
      if (link.closest('nav') && link.hash === '#' + currentNav) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    if(changed)for(const fn of listeners) {
      fn({id,key});
      if(current!==id||currentKey!==key)return;
    }
    if (focusId !== undefined) {
      const pane = panes.get(id);
      const target = document.getElementById(focusId || pane.getAttribute('aria-labelledby'));
      if (target && pane.contains(target)) target.focus({preventScroll: true});
      window.scrollTo(0, 0);
      if (focusId) target?.scrollIntoView({block: 'nearest'});
    }
  }

  function open(id, focusId = '', key = projectPanes.has(id) ? currentKey : null) {
    if (!panes.has(id)) return;
    if (!projectPanes.has(id))key=null;
    const hash='#'+id+(key?'?key='+encodeURIComponent(key):'');
    if (location.hash !== hash) history.pushState(null, '', hash);
    show(id, focusId, key);
  }
  function replace(id, focusId = '', key = null) {
    if (!panes.has(id)) return;
    history.replaceState(null,'','#'+id+(key?'?key='+encodeURIComponent(key):''));
    show(id,focusId,key);
  }

  function plainClick(event) {
    return !event.defaultPrevented && event.button === 0 && !event.ctrlKey &&
      !event.metaKey && !event.shiftKey && !event.altKey;
  }

  for (const link of links) link.addEventListener('click', event => {
    if (!plainClick(event)) return;
    event.preventDefault();
    const {id,key}=parse(link.hash);
    if(key)open(id,'',key);
    else open(id);
  });
  document.querySelector('.skip-link').addEventListener('click', event => {
    if (!plainClick(event)) return;
    event.preventDefault();
    main.focus();
  });

  // Hash changes also fire for Back/Forward between these fragment entries.
  function fromHash(focus) {
    const {id,key}=parse(location.hash);
    show(id,focus,key);
  }
  window.addEventListener('hashchange', () => fromHash(''));
  fromHash(undefined);
  return {open,replace, revision: () => revision, route:()=>({id:current,key:currentKey}),
    subscribe(fn){listeners.add(fn);return ()=>listeners.delete(fn);}};
})();
