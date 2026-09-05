// Deterministic synthetic API fixture; no camera footage or model weights.
import http from 'node:http';
import fs from 'node:fs';
const report = JSON.parse(fs.readFileSync(new URL('./fixtures/report.json', import.meta.url)));
const replay = JSON.parse(fs.readFileSync(new URL('./fixtures/replay.json', import.meta.url)));
http.createServer((request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', '*');
  if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
  const path = new URL(request.url, 'http://localhost').pathname;
  let status = 200, body = report;
  if (path === '/health') body = {status: 'ok'};
  else if (path.includes('/missing')) { status = 404; body = {detail: 'not found'}; }
  else if (path.includes('/gone') || path.endsWith('/video') || path.includes('/expired/') ) { status = 410; body = {detail: 'expired'}; }
  else if (path.includes('/unavailable')) { status = 503; body = {detail: 'unavailable'}; }
  else if (path.endsWith('/replay')) body = replay;
  else if (path.endsWith('/expired')) body = {...report, analysis_id: 'expired'};
  response.writeHead(status, {'Content-Type': 'application/json'}).end(JSON.stringify(body));
}).listen(8129, '127.0.0.1');
