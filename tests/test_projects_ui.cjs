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

test('a title from any sibling labels the whole project while chunks stay distinct', ()=>{
  const actual=vm.runInContext(`JSON.stringify((()=>{
    const key='youtube:U8bVUVQMPM8';
    const common={project_key:key,youtube_video_id:'U8bVUVQMPM8'};
    const rows=[
      {...common,id:'vod',name:'YouTube-U8bVUVQMPM8-12345678-video.mp4'},
      {...common,id:'live',name:'YouTube-U8bVUVQMPM8-abcdef12-chunk-00000002.mp4',youtube_title:'  GTA Highlights  '},
      {id:'local',name:'my own file.mp4',youtube_title:'not a YouTube source'}
    ];
    const bySource=sourceProjects(rows);
    const items=[{source_id:'vod',name:'draft.mp4',kind:'draft'}];
    return [collectProjects(items,bySource)[0].label,
      rows.map(row=>sourceOptionLabels(rows,bySource).get(row.id)),
      findProjectClips(items,bySource,'all','gta u8bvuvqmpm8').length];
  })())`,context);
  assert.deepEqual(JSON.parse(actual),['GTA Highlights',['GTA Highlights','GTA Highlights · Chunk 2','my own file.mp4'],1]);
});
