// Deterministic synthetic API fixture; no camera footage or model weights.
import http from 'node:http';
import fs from 'node:fs';
const report = JSON.parse(fs.readFileSync(new URL('./fixtures/report.json', import.meta.url)));
const replay = JSON.parse(fs.readFileSync(new URL('./fixtures/replay.json', import.meta.url)));
const compare = JSON.parse(fs.readFileSync(new URL('./fixtures/compare.json', import.meta.url)));
const poseOf = { c1: replay.player_sequence, c2: replay.template_sequence };
const players = [compare.player];
http.createServer((request, response) => {
 try {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', '*');
  if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
  const path = new URL(request.url, 'http://localhost').pathname;
  let status = 200, body = report;
  if (path === '/health') body = {status: 'ok'};
  else if (path === '/api/v1/compare/players' && request.method === 'POST') {
    status = 201;
    const created = {...compare.player, player_id: `p${players.length + 1}`, name: '新学员'};
    players.push(created);
    body = created;
  }
  else if (path === '/api/v1/compare/players') body = players;
  else if (/^\/api\/v1\/compare\/players\/[a-z0-9]+$/.test(path)) body = compare.playerDetail;
  else if (path.includes('/compare/players/') && path.endsWith('/templates') && request.method === 'POST') {
    status = 201; body = compare.playerDetail.templates[0];
  }
  else if (path.includes('/compare/players/') && path.endsWith('/clips') && request.method === 'POST') {
    status = 201; body = compare.playerDetail.clips[1];
  }
  else if (path.endsWith('/compare/comparisons') && request.method === 'POST') body = compare.comparison;
  else if (path.endsWith('/compare/comparisons/demo/metrics')) body = compare.metrics;
  else if (path.endsWith('/compare/comparisons/demo/report')) body = compare.comparison;
  else if (path.endsWith('/compare/comparisons/demo')) body = compare.comparison;
  else if (path.includes('/compare/clips/') && path.endsWith('/pose')) {
    body = poseOf[path.split('/')[5]] ?? replay.player_sequence;
  }
  else if (path.includes('/compare/clips/')) body = compare.playerDetail.clips[0];
  else if (path.includes('/missing')) { status = 404; body = {detail: 'not found'}; }
  else if (path.includes('/gone') || path.endsWith('/video') || path.includes('/expired/') ) { status = 410; body = {detail: 'expired'}; }
  else if (path.includes('/unavailable')) { status = 503; body = {detail: 'unavailable'}; }
  else if (path.endsWith('/replay')) body = replay;
  else if (path.endsWith('/expired')) body = {...report, analysis_id: 'expired'};
  response.writeHead(status, {'Content-Type': 'application/json'}).end(JSON.stringify(body));
 } catch (error) {
  console.error('[stub crash]', request.method, request.url, error);
  if (!response.headersSent) response.writeHead(500).end('{}');
 }
}).listen(8129, '127.0.0.1');
