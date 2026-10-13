// Original synthetic color fields; no camera footage or downloaded media.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const output = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const recipes = [
  { name: 'compare-a.webm', width: 96, height: 64, seconds: 3 },
  { name: 'compare-b.webm', width: 48, height: 32, seconds: 3 },
  { name: 'homecourt-session.webm', width: 96, height: 64, seconds: 20 },
  { name: 'compare-vfr-a.webm', width: 96, height: 64, pts: [0, 80, 310, 600, 940, 1320, 1580, 1800] },
  { name: 'compare-vfr-b.webm', width: 96, height: 64, pts: [0, 120, 210, 420, 1000, 1400, 1670, 1850] },
];
const digest = data => createHash('sha256').update(data).digest('hex');
const version = digest(readFileSync(fileURLToPath(import.meta.url)));
const stampPath = join(output, '.generated.json');
let stamp;
try { stamp = JSON.parse(readFileSync(stampPath, 'utf8')); } catch { /* Generate on a fresh checkout. */ }
if (stamp?.version === version && recipes.every(recipe => {
  const path = join(output, recipe.name);
  return existsSync(path) && digest(readFileSync(path)) === stamp.files[recipe.name];
})) {
  console.log('Synthetic video fixtures are current.');
} else {
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const files = {};
  for (const recipe of recipes) {
    const temporary = join(output, `${recipe.name}.tmp.webm`);
    const isVfr = !!recipe.pts;
    const input = `color=c=0x18222e:s=${recipe.width}x${recipe.height}:r=${isVfr ? 100 : 10}:d=${recipe.seconds ?? .08}`;
    let filter = 'drawbox=x=iw/2:y=0:w=iw/2:h=ih:color=0x22b455:t=fill';
    if (isVfr) {
      let expression = `${recipe.pts.at(-1)}`;
      for (let i = recipe.pts.length - 2; i >= 0; i--) expression = `if(eq(N,${i}),${recipe.pts[i]},${expression})`;
      filter += `,settb=1/1000,setpts='${expression}'`;
    }
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', input,
      '-vf', filter, '-an', '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8',
      '-crf', '10', '-b:v', '0', '-pix_fmt', 'yuv420p'];
    if (isVfr) args.push('-fps_mode', 'vfr', '-enc_time_base', '1:1000', '-frames:v', `${recipe.pts.length}`);
    const result = spawnSync(ffmpeg, [...args, temporary], { encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      rmSync(temporary, { force: true });
      throw new Error(`Cannot generate ${recipe.name}. Install FFmpeg with libvpx or set FFMPEG_PATH.\n${result.error?.message || result.stderr}`);
    }
    renameSync(temporary, join(output, recipe.name));
    files[recipe.name] = digest(readFileSync(join(output, recipe.name)));
  }
  writeFileSync(stampPath, JSON.stringify({ version, files }, null, 2) + '\n');
  console.log(`Generated ${recipes.length} synthetic video fixtures locally.`);
}
