// Deterministic synthetic API fixture; no camera footage or model weights.
import http from 'node:http';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const report = JSON.parse(fs.readFileSync(new URL('./fixtures/report.json', import.meta.url)));
const replay = JSON.parse(fs.readFileSync(new URL('./fixtures/replay.json', import.meta.url)));
const compare = JSON.parse(fs.readFileSync(new URL('./fixtures/compare.json', import.meta.url)));
const poseOf = { c1: replay.player_sequence, c2: replay.template_sequence };
const players = [compare.player];
const comparisons = new Map();
const importedClips = new Map();
const importedAnalyses = new Map();
const trainingSessions = new Map();
let importNumber = 0;
async function multipart(request) {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  return new Response(Buffer.concat(chunks), { headers: { 'Content-Type': request.headers['content-type'] } }).formData();
}
async function importSource(form) {
  const source = JSON.parse(form.get('source'));
  const file = form.get('video');
  const hash = createHash('sha256').update(Buffer.from(await file.arrayBuffer())).digest('hex');
  return { ...source, original_filename: file.name, original_sha256: hash, selected_sha256: '0'.repeat(64) };
}
function comparisonFor(id) {
  if (!comparisons.has(id)) {
    const state = structuredClone(compare.comparison);
    state.comparison_id = id;
    if (id === 'render') {
      state.baseline_clip_id = 'r1'; state.comparison_clip_id = 'r2';
      state.spatial.scale = 2;
      state.temporal.offset_ms_a = state.temporal.offset_ms_b = 0;
    }
    if (id === 'vfr') {
      state.baseline_clip_id = 'vf1'; state.comparison_clip_id = 'vf2';
      state.temporal.offset_ms_a = state.temporal.offset_ms_b = 0;
      state.phases_a = [{phase:'准备',start_frame:0,end_frame:1},{phase:'出手',start_frame:2,end_frame:7}];
      state.phases_b = [{phase:'准备',start_frame:0,end_frame:2},{phase:'出手',start_frame:3,end_frame:7}];
    }
    comparisons.set(id, state);
  }
  return comparisons.get(id);
}
function renderPose(id) {
  return {...replay.player_sequence, width: id === 'r1' ? 96 : 48, height: id === 'r1' ? 64 : 32,
    fps: 10, frames: Array.from({length:30}, (_,i) => ({frame_idx:i,t_ms:i*100,keypoints:[]}))};
}
function vfrPose(id) {
  const times = id === 'vf1' ? [0,80,310,600,940,1320,1580,1800] : [0,120,210,420,1000,1400,1670,1850];
  return {...replay.player_sequence,width:96,height:64,fps:8/(times.at(-1)/1000),
    frames:times.map((t_ms,frame_idx) => ({frame_idx,t_ms,keypoints:[]}))};
}

function serveVideo(request, response, filename) {
  const video = fs.readFileSync(new URL(`./fixtures/${filename}`, import.meta.url));
  response.setHeader('Content-Type', 'video/webm');
  response.setHeader('Accept-Ranges', 'bytes');
  const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  if (range) {
    const start = Number(range[1]), end = Math.min(Number(range[2] || video.length - 1), video.length - 1);
    if (start > end) { response.writeHead(416, {'Content-Range':`bytes */${video.length}`}).end(); return; }
    response.writeHead(206, {'Content-Range':`bytes ${start}-${end}/${video.length}`, 'Content-Length':end-start+1})
      .end(video.subarray(start,end+1));
  } else response.writeHead(200, {'Content-Length':video.length}).end(video);
}

http.createServer(async (request, response) => {
 try {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
  const path = new URL(request.url, 'http://localhost').pathname;
  const match = path.match(/^\/api\/v1\/compare\/comparisons\/([^/]+)(.*)$/);
  if (path.endsWith('/source-video')) {
    serveVideo(request, response, 'compare-a.webm');
    return;
  }
  if (match && match[2].startsWith('/video/')) {
    if (match[1] === 'vfr') { serveVideo(request,response,`compare-vfr-${match[2].endsWith('/b') ? 'b' : 'a'}.webm`); return; }
    const side = match[2].endsWith('/b') && match[1] === 'render' ? 'b' : 'a';
    serveVideo(request, response, `compare-${side}.webm`);
    return;
  }
  let status = 200, body = report;
  if (path === '/health') body = {status: 'ok'};
  else if (path === '/api/v1/training/sessions' && request.method === 'POST') {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    const existing = trainingSessions.get(input.session_id);
    if (existing && JSON.stringify(existing.input) !== JSON.stringify(input)) {
      status = 409; body = {detail:'session UUID already has different recorded data'};
    } else if (existing) body = existing.record;
    else {
      const attempts = input.sets.flatMap(set => set.attempts);
      const makes = attempts.filter(Boolean).length;
      body = {...input, created_at:new Date().toISOString(), totals:{attempts:attempts.length,makes,
        accuracy_pct:attempts.length ? 100*makes/attempts.length : null,
        duration_ms:Date.parse(input.completed_at)-Date.parse(input.started_at),
        completed_sets:input.sets.filter(set => set.attempts.length === input.planned_reps).length}};
      trainingSessions.set(input.session_id,{input,record:body}); status = 201;
    }
  }
  else if (path === '/api/v1/training/sessions') {
    const sessions = [...trainingSessions.values()].map(item => item.record).sort((a,b) => b.completed_at.localeCompare(a.completed_at));
    const attempts = sessions.reduce((sum,item) => sum+item.totals.attempts,0);
    const makes = sessions.reduce((sum,item) => sum+item.totals.makes,0);
    body = {sessions:sessions.slice(0,100),has_more:sessions.length>100,
      summary:{sessions:sessions.length,completed_sessions:sessions.filter(item => item.status==='completed').length,
        attempts,makes,accuracy_pct:attempts?100*makes/attempts:null,
        duration_ms:sessions.reduce((sum,item)=>sum+item.totals.duration_ms,0)}};
  }
  else if (path === '/api/v1/compare/players' && request.method === 'POST') {
    status = 201;
    const created = {...compare.player, player_id: `p${players.length + 1}`, name: '新学员'};
    players.push(created);
    body = created;
  }
  else if (path === '/api/v1/compare/players') body = players;
  else if (/^\/api\/v1\/compare\/players\/[a-z0-9]+$/.test(path)) body = {
    ...compare.playerDetail,
    clips: [...compare.playerDetail.clips, ...[...importedClips.values()].filter(clip => clip.player_id === path.split('/').at(-1))],
  };
  else if (path.includes('/compare/players/') && path.endsWith('/templates') && request.method === 'POST') {
    status = 201; body = compare.playerDetail.templates[0];
  }
  else if (path.includes('/compare/players/') && path.endsWith('/clips') && request.method === 'POST') {
    status = 201;
    const form = await multipart(request);
    if (form.has('source')) {
      const source = await importSource(form);
      const kind = form.get('kind');
      body = {...compare.playerDetail.clips[kind === 'baseline' ? 0 : 1], clip_id:`hc${++importNumber}`,
        player_id:path.split('/')[5],template_id:form.get('template_id'),kind,filename:source.original_filename,
        duration_ms:source.end_ms-source.start_ms,source};
      importedClips.set(body.clip_id,body);
    } else body = compare.playerDetail.clips[1];
  }
  else if (path.endsWith('/compare/comparisons') && request.method === 'POST') {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw);
    body = {...structuredClone(compare.comparison),...input,comparison_id:`created${++importNumber}`};
    comparisons.set(body.comparison_id,body);
  }
  else if (match) {
    body = comparisonFor(match[1]);
    if (match[2] === '/metrics') body = compare.metrics;
    else if (match[2] === '/report' && request.method === 'POST') {
      body.report = {created_at:new Date().toISOString(),keyframes:[],phase_offsets:[],
                     summary_text:JSON.stringify({tx:body.spatial.tx,opacity:body.opacity_default})};
    } else if (!match[2] && request.method === 'PATCH') {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const patch = JSON.parse(raw);
      if (patch.temporal) patch.temporal = {...body.temporal,...patch.temporal};
      Object.assign(body,patch);
      if (patch.spatial || patch.temporal || patch.phases_a || patch.phases_b) body.report = null;
    }
  }
  else if (path.includes('/compare/clips/') && path.endsWith('/pose')) {
    const id = path.split('/')[5];
    body = id.startsWith('vf') ? vfrPose(id) : id.startsWith('r') ? renderPose(id) : poseOf[id] ?? replay.player_sequence;
  }
  else if (path.includes('/compare/clips/')) {
    const id = path.split('/')[5];
    if (id.startsWith('vf')) body = {...compare.playerDetail.clips[id === 'vf1' ? 0 : 1],clip_id:id,
      width:96,height:64,frame_count:8,duration_ms:id === 'vf1' ? 1800 : 1850,fps:8/(id === 'vf1' ? 1.8 : 1.85)};
    else body = importedClips.get(id) ?? compare.playerDetail.clips.find(clip => clip.clip_id === id) ?? {...compare.playerDetail.clips[0],
      clip_id:id,width:id === 'r1'?96:48,height:id === 'r1'?64:32,frame_count:30,duration_ms:3000};
  }
  else if (path === '/api/v1/analysis' && request.method === 'POST') {
    const form = await multipart(request);
    if (form.has('source')) {
      const source = await importSource(form);
      body = {...report,analysis_id:`homecourt${++importNumber}`,source,timing_mode:source.timing_mode,
        timing_reliable:source.timing_mode === 'realtime',timing_score:source.timing_mode === 'realtime' ? report.timing_score : null};
      importedAnalyses.set(body.analysis_id,body);
    }
  }
  else if (/^\/api\/v1\/analysis\/homecourt\d+$/.test(path)) body = importedAnalyses.get(path.split('/').at(-1)) ?? report;
  else if (path.includes('/missing')) { status = 404; body = {detail: 'not found'}; }
  else if (path.includes('/gone') || path.endsWith('/video') || path.includes('/expired/') ) { status = 410; body = {detail: 'expired'}; }
  else if (path.includes('/unavailable')) { status = 503; body = {detail: 'unavailable'}; }
  else if (path.endsWith('/replay')) body = replay;
  else if (path.endsWith('/expired')) body = {...report, analysis_id: 'expired'};
  else if (path.endsWith('/analysis/source')) body = {...report, template_source_video_url:'/api/v1/templates/curry_v3/source-video'};
  response.writeHead(status, {'Content-Type': 'application/json'}).end(JSON.stringify(body));
 } catch (error) {
  console.error('[stub crash]', request.method, request.url, error);
  if (!response.headersSent) response.writeHead(500).end('{}');
 }
}).listen(8129, '127.0.0.1');
