'use strict';

const editorDefaults = (() => {
  const key = 'sheesh-editor-defaults-v1';
  const base = Object.freeze({aspect:'9:16',layout:'fit',caption:'clean',profile:'high'});
  const allowed = {
    aspect:['9:16','16:9','1:1'], layout:['fit','fill'],
    caption:['clean','bold','minimal'], profile:['high','compact']
  };
  const field = name => document.getElementById('default-'+name);
  function validate(input) {
    return Object.fromEntries(Object.entries(base).map(([name,value]) =>
      [name,allowed[name].includes(input?.[name]) ? input[name] : value]));
  }
  let values = {...base};
  try { values = validate(JSON.parse(localStorage.getItem(key))); } catch (_) { /* Defaults still work for this page. */ }
  function refresh() { for (const [name,value] of Object.entries(values)) field(name).value=value; }
  function save(input) {
    values = validate(input);
    refresh();
    const status = document.getElementById('default-status');
    try {
      localStorage.setItem(key, JSON.stringify(values));
      status.textContent = 'Defaults saved in this browser. Existing edits are unchanged.';
    } catch (_) { status.textContent = 'Defaults updated for this page only. Browser storage is unavailable.'; }
  }
  document.getElementById('defaults-form').addEventListener('submit', event => {
    event.preventDefault();
    save(Object.fromEntries(Object.keys(base).map(name => [name,field(name).value])));
  });
  document.getElementById('reset-defaults').addEventListener('click', () => save(base));
  refresh();
  return { read:() => ({...values}) };
})();

const editorTabs = (() => {
  const list = document.getElementById('editor-tabs');
  const tabs = Array.from(list.querySelectorAll('[role="tab"]'));
  const active = id => tabs.find(tab => tab.id === 'tab-'+id);
  function open(id, focus=false) {
    const target = active(id);
    if (!target) return;
    for (const tab of tabs) {
      const selected = tab === target;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !selected;
    }
    if (focus) target.focus();
  }
  for (const [i,tab] of tabs.entries()) {
    const id = tab.id.slice(4);
    tab.addEventListener('click', () => open(id));
    tab.addEventListener('keydown', event => {
      const j = {ArrowLeft:(i-1+tabs.length)%tabs.length,ArrowRight:(i+1)%tabs.length,Home:0,End:tabs.length-1}[event.key];
      if (j === undefined || event.ctrlKey || event.altKey || event.metaKey) return;
      event.preventDefault();
      open(tabs[j].id.slice(4),true);
    });
  }
  open('trim');
  return {open};
})();
