'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const vm = require('node:vm');
const ids = ['import-workspace', 'analysis-workspace', 'editor-workspace', 'export-workspace', 'projects-workspace', 'project-workspace'];

function boot(hash = '') {
  const loc = {hash}, headings = {}, scrolls = [], events = {};
  const main = {focus() { main.focused = true; }};
  const panes = ids.map(id => {
    const title = {focus() { title.focused = true; }};
    headings[id+'-title'] = title;
    return {
      id, title, media: {paused:true, pause(){ this.paused=true; }},
      querySelectorAll() { return [this.media]; },
      getAttribute() { return id+'-title'; },
      contains(el) { return el === this.title; }
    };
  });
  const links = [...ids.map(id => ({id, nav:true})), {id:ids[0], nav:false}].map(({id, nav}) => ({
    hash:'#'+id, attrs:{}, closest:()=>nav,
    setAttribute(key,val){this.attrs[key]=val;}, removeAttribute(key){delete this.attrs[key];},
    addEventListener(_,fn){this.click=fn;}
  }));
  const skip = {addEventListener(_,fn){this.click=fn;}};
  const replacements = [];
  const context=vm.createContext({
    document:{querySelectorAll:s=>s==='.workspace-pane'?panes:links, querySelector:()=>skip, getElementById:id=>headings[id]||(id==='workspace'?main:null)},
    URLSearchParams, location:loc, history:{pushState(_,__,next){replacements.push(next);loc.hash=next;}},
    window:{scrollTo(...args){scrolls.push(args);}, addEventListener(k,fn){events[k]=fn;}}
  });
  vm.runInContext(readFileSync(new URL('../app/static/workspace.js','file://'+__filename),'utf8'),context);
  const active=()=>panes.filter(p=>!p.hidden).map(p=>p.id);
  return {run:code=>vm.runInContext(code,context),main, active, links, panes, skip, loc, events, replacements, scrolls};
}
const click = (el, props={})=>{
  let prevented=false;
  el.click({button:0, preventDefault(){prevented=true;}, ...props});
  return prevented;
};

test('navigation is deep-linkable and pauses offscreen playback without replacing editor DOM', () => {
  const b=boot('#editor-workspace');
  const editor=b.panes[2]; editor.media.paused=false; editor.unsavedTrim='existing edit';
  assert.deepEqual(b.active(),[ids[2]]);
  assert.equal(b.links[2].attrs['aria-current'],'page');
  assert.equal(click(b.links[3]),true);
  assert.deepEqual(b.active(),[ids[3]]);
  assert.equal(editor.media.paused,true);
  assert.equal(b.panes[3].title.focused,true);
  assert.deepEqual(b.replacements,['#'+ids[3]]);
  b.loc.hash='#'+ids[2]; b.events.hashchange();
  assert.deepEqual(b.active(),[ids[2]]);
  assert.equal(editor.unsavedTrim,'existing edit');
  assert.equal(b.links[3].attrs['aria-current'],undefined);
});

test('skip links keep the view active and modified clicks retain link behavior', () => {
  const b=boot('#'+ids[1]);
  assert.equal(click(b.links[2],{ctrlKey:true}),false);
  assert.deepEqual(b.replacements,[]);
  assert.equal(click(b.skip),true);
  assert.equal(b.main.focused,true);
  assert.deepEqual(b.active(),[ids[1]]);
  assert.deepEqual(boot('#invalid').active(),[ids[0]]);
});

test('project keys survive navigation and history without replacing an edit', () => {
  const b=boot('#project-workspace?key=youtube%3AAbCdEfGhIJK');
  assert.deepEqual(b.active(),['project-workspace']);
  assert.equal(b.links[4].attrs['aria-current'],'page');
  b.run("workspace.open('editor-workspace')");
  assert.equal(b.loc.hash,'#editor-workspace?key=youtube%3AAbCdEfGhIJK');
  b.run("workspace.open('export-workspace')");
  assert.equal(b.loc.hash,'#export-workspace?key=youtube%3AAbCdEfGhIJK');
  b.loc.hash='#project-workspace?key=youtube%3AAbCdEfGhIJK'; b.events.hashchange();
  assert.equal(b.run('workspace.route().key'),'youtube:AbCdEfGhIJK');
  click(b.links[4]); assert.equal(b.run('workspace.route().key'),null);
});
