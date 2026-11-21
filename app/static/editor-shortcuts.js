'use strict';

// Route editor shortcuts through the same enabled controls as pointer users.
(() => {
  const editor = document.getElementById('editor-workspace');
  if (!editor) return;

  const actions = new Map([
    [' ', ['play', 'Space']],
    ['[', ['start-here', '[']],
    [']', ['end-here', ']']],
  ]);
  const interactive = 'form, dialog, [role="dialog"], input, textarea, select, button, summary, a, video, audio, [role="button"], [role="textbox"], [role="slider"], [role="combobox"]';
  for (const [id, key] of actions.values()) {
    document.getElementById(id)?.setAttribute('aria-keyshortcuts', key);
  }

  editor.addEventListener('keydown', event => {
    if (editor.hidden || event.defaultPrevented || event.isComposing || event.repeat ||
        event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
    const target = event.target;
    if (!target || !editor.contains(target) || target.isContentEditable ||
        typeof target.closest !== 'function' || target.closest(interactive) ||
        document.querySelector('dialog[open], [aria-modal="true"]:not([hidden])')) return;
    const action = actions.get(event.key);
    if (!action) return;
    const button = document.getElementById(action[0]);
    if (!button || button.disabled || button.closest('[hidden], [inert]')) return;

    event.preventDefault();
    button.click();
  });
})();
