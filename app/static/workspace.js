'use strict';

// Keep a single editor and its unsaved state mounted while switching views.
const workspace = (() => {
  const panes = new Map(Array.from(document.querySelectorAll('.workspace-pane'), pane => [pane.id, pane]));
  const links = Array.from(document.querySelectorAll('[data-workspace-link]'));
  const main = document.getElementById('workspace');
  const defaultId = 'import-workspace';
  let current = null;
  let revision = 0;

  function show(id, focusId) {
    if (!panes.has(id)) id = defaultId;
    const previous = current;
    if (previous !== id) {
      current = id;
      revision++;
      if (previous) {
        for (const media of panes.get(previous).querySelectorAll('video')) {
          if (!media.paused) media.pause();
        }
      }
    }
    for (const [key, pane] of panes) pane.hidden = key !== id;
    for (const link of links) {
      if (link.closest('nav') && link.hash === '#' + id) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    if (focusId !== undefined) {
      const pane = panes.get(id);
      const target = document.getElementById(focusId || pane.getAttribute('aria-labelledby'));
      if (target && pane.contains(target)) target.focus({preventScroll: true});
      window.scrollTo(0, 0);
      if (focusId) target?.scrollIntoView({block: 'nearest'});
    }
  }

  function open(id, focusId = '') {
    if (!panes.has(id)) return;
    if (location.hash !== '#' + id) history.pushState(null, '', '#' + id);
    show(id, focusId);
  }

  function plainClick(event) {
    return !event.defaultPrevented && event.button === 0 && !event.ctrlKey &&
      !event.metaKey && !event.shiftKey && !event.altKey;
  }

  for (const link of links) link.addEventListener('click', event => {
    if (!plainClick(event)) return;
    event.preventDefault();
    open(link.hash.slice(1));
  });
  document.querySelector('.skip-link').addEventListener('click', event => {
    if (!plainClick(event)) return;
    event.preventDefault();
    main.focus();
  });

  // Hash changes also fire for Back/Forward between these fragment entries.
  window.addEventListener('hashchange', () => show(location.hash.slice(1), ''));
  show(location.hash.slice(1));
  return {open, revision: () => revision};
})();
