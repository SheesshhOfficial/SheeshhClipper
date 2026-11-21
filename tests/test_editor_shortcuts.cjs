'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {readFileSync} = require('node:fs');

const script = readFileSync(new URL('../app/static/editor-shortcuts.js', 'file://' + __filename), 'utf8');
function setup() {
  let handle, modal = false;
  const triggers = new Map(['play', 'start-here', 'end-here'].map(id => [id, {
    shortcut: '', clicks: 0, disabled: false, hidden: false,
    setAttribute(key, value) {assert.equal(key, 'aria-keyshortcuts'); this.shortcut = value;},
    closest() {return this.hidden;}, click() {this.clicks++;}
  }]));
  const editor = {
    hidden: false, contains: target => !target.outside,
    addEventListener(type, listener) {assert.equal(type, 'keydown'); handle = listener;}
  };
  const doc = {getElementById: id => id === 'editor-workspace' ? editor : triggers.get(id),
    querySelector: () => modal};
  vm.runInNewContext(script, {document: doc});
  return {editor, triggers, setModal: value => {modal = value;},
    send(key, extra = {}) {
      const event = {key, target: {closest: () => null}, prevented: false,
        preventDefault() {this.prevented = true;}, ...extra};
      handle(event);
      return event.prevented;
    }};
}
test('keys drive the existing enabled controls', () => {
  const {send, triggers} = setup();
  for (const [key, id, label] of [[' ', 'play', 'Space'], ['[', 'start-here', '['], [']', 'end-here', ']']]) {
    assert.equal(triggers.get(id).shortcut, label);
    assert.equal(send(key), true);
    assert.equal(triggers.get(id).clicks, 1);
  }
  assert.equal(send('Enter'), false);
  assert.equal(send('e'), false);
});
test('does not intercept hidden editor, buttons, form inputs, or modal interactions', () => {
  const {editor, send, triggers, setModal} = setup();
  for (const extra of [{target: {outside: true, closest: () => null}}, {target: {closest: () => true}},
    {target: {isContentEditable: true, closest: () => null}}, {ctrlKey: true}, {altKey: true},
    {metaKey: true}, {shiftKey: true}, {defaultPrevented: true}, {repeat: true}, {isComposing: true}]) {
    assert.equal(send(' ', extra), false);
  }
  setModal(true);
  assert.equal(send(' '), false);
  setModal(false);
  editor.hidden = true;
  assert.equal(send(' '), false);
  editor.hidden = false;
  triggers.get('play').disabled = true;
  assert.equal(send(' '), false);
  triggers.get('play').disabled = false;
  triggers.get('play').hidden = true;
  assert.equal(send(' '), false);
  assert.equal(triggers.get('play').clicks, 0);
});
