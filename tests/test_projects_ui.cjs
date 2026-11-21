'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const vm = require('node:vm');
const context = vm.createContext();
vm.runInContext(readFileSync(new URL('../app/static/projects.js','file://'+__filename),'utf8'),context);

test('saved clips use the same project for multiple YouTube imports or chunks, not identical file names', ()=>{
  const actual = vm.runInContext(`JSON.stringify(collectProjects([
    {id:'d', source_id:'vod'}, {id:'e', source_id:'live'}, {id:'f',source_id:'l1'}, {id:'g',source_id:'l2'}, {id:'old'}
  ], sourceProjects([
    {id:'vod',name:'first', project_key:'youtube:test', youtube_video_id:'test'},
    {id:'live',name:'second', project_key:'youtube:test', youtube_video_id:'test'},
    {id:'l1', name:'same.mp4'}, {id:'l2', name:'same.mp4'}
  ])))`,context);
  assert.deepEqual(JSON.parse(actual).map(({key,items})=>[key,items.map(item=>item.id)]),[
    ['youtube:test',['d','e']],['local:l1',['f']],['local:l2',['g']],['unlinked',['old']]
  ]);
});

test('library search matches project and clip text and combines with the kind filter', ()=>{
  const actual = vm.runInContext(`JSON.stringify(findProjectClips([
    {id:'a',name:'First render.mp4',source_id:'vod',kind:'draft'},
    {id:'b',name:'First render.mp4',source_id:'vod',kind:'export'},
    {id:'c',name:'First render.mp4',source_id:'local',kind:'draft'},
    {id:'d',name:'Something else.mp4',source_id:'vod',kind:'draft'}
  ], sourceProjects([
    {id:'vod',name:'desktop',project_key:'youtube:mix',youtube_video_id:'AbC'},
    {id:'local',name:'capture.mp4'}
  ]), 'draft', '  ABC   FIRST '))`,context);
  assert.deepEqual(JSON.parse(actual).map(item=>item.id),['a']);
});
