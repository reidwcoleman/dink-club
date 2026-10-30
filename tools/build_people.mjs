// Build the people from the Microsoft Rocketbox avatars (MIT) in assets-src/rocketbox
// (fetched by tools/fetch_assets.py). Runs the conversion page (src/dev/rbconvert.ts, ported
// from ApexGP) in headless Chrome against the dev server and writes public/people/.
//
//   npm run dev &   node tools/build_people.mjs [--port 5230] [--only Name,Name] [--anims-only] [--no-anims]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = path.join(ROOT, 'assets-src', 'rocketbox');
const OUT = path.join(ROOT, 'public', 'people');
const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 ? args[i + 1] : d;
};
const has = (k) => args.includes('--' + k);
const port = opt('port', '5230');

/** texture sizes per tier: players are seen in close-up replays, staff at mid range, the crowd only through baked impostors */
const TIERS = {
  player: { tex: 2048, ntex: 1024, hair: 1024 },
  staff: { tex: 1024, ntex: 512, hair: 512 },
  crowd: { tex: 512, ntex: 256, hair: 256 },
};
export const AVATARS = {
  player: ['Sports_Male_04', 'Sports_Male_02', 'Sports_Male_03', 'Sports_Female_02'],
  staff: ['Business_Male_02', 'Business_Female_01', 'Security_Male_01'],
  crowd: [...Array.from({ length: 16 }, (_, i) => `Male_Adult_${String(i + 1).padStart(2, '0')}`), ...Array.from({ length: 12 }, (_, i) => `Female_Adult_${String(i + 1).padStart(2, '0')}`)],
};

/** our clip name ← the Rocketbox clip; trimmed / loop-blended where the source is long */
export const CLIPS = [
  { name: 'idle', src: 'idle_neutral_01', range: [0, 12], loop: 0.6 },
  { name: 'idle2', src: 'idle_neutral_02', range: [0, 12], loop: 0.6 },
  { name: 'breathe', src: 'idle_breathe_01', loop: 0.4 },
  { name: 'look', src: 'idle_look_around_01', loop: 0.5 },
  { name: 'wait', src: 'idle_waiting_01', range: [0, 12], loop: 0.6 },
  { name: 'cheer', src: 'cheer_01', range: [0, 10], loop: 0.5 },
  { name: 'cheer3', src: 'cheer_03', loop: 0.4 },
  { name: 'cheer4', src: 'cheer_04', loop: 0.4 },
  { name: 'cheer5', src: 'cheer_05', loop: 0.4 },
  { name: 'clap', src: 'claphands_01', range: [0, 8], loop: 0.4 },
  { name: 'clap2', src: 'claphands_02', loop: 0.4 },
  { name: 'wave', src: 'wave_01', loop: 0.4 },
  { name: 'shrug', src: 'gestic_shrug_01' },
  { name: 'angry', src: 'idle_angry_01', loop: 0.4 },
  { name: 'dust', src: 'idle_dust_01', loop: 0.4 },
  { name: 'crouch', src: 'crouch_idle', loop: 0.5 },
  { name: 'sit', src: 'sit_chair_idle_neutral_01', range: [0, 12], loop: 0.6 },
  { name: 'sit_breathe', src: 'sit_chair_breathe_01', loop: 0.5 },
  { name: 'sit_look', src: 'sit_chair_idle_look_around', loop: 0.5 },
  { name: 'sit_wait', src: 'sit_chair_idle_waiting_01', range: [0, 12], loop: 0.6 },
  { name: 'sit_think', src: 'sit_chair_gestic_thoughtful', loop: 0.5 },
  { name: 'talk', src: 'gestic_talk_neutral_01', range: [0, 12], loop: 0.6 },
  { name: 'photo', src: 'take_picture', loop: 0.5 },
  { name: 'walk', src: 'walk_neutral_01', inPlace: true, fps: 30 },
  { name: 'walk_fast', src: 'walk_fast_01', inPlace: true, fps: 30 },
  { name: 'jog', src: 'run_slow_01', inPlace: true, fps: 30 },
  { name: 'run', src: 'run_neutral_01', inPlace: true, fps: 30 },
  { name: 'sprint', src: 'run_fast_01', inPlace: true, fps: 30 },
];

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}] ${m.text().slice(0, 300)}`);
});
page.on('pageerror', (e) => console.log('[pageerror] ' + e.message));
await page.route('**/__rb/ls**', (route) => {
  const dir = new URL(route.request().url()).searchParams.get('dir');
  const full = path.join(SRC, dir);
  const list = fs.existsSync(full) ? fs.readdirSync(full) : [];
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(list) });
});
page.setDefaultTimeout(900000);
await page.goto(`http://localhost:${port}/src/dev/rbconvert.html`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
fs.mkdirSync(OUT, { recursive: true });
const indexPath = path.join(OUT, 'index.json');
const index = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) : { avatars: {}, anims: {} };
const write = (files) => {
  let n = 0;
  for (const [f, b64] of Object.entries(files)) {
    const buf = Buffer.from(b64, 'base64');
    fs.writeFileSync(path.join(OUT, f), buf);
    n += buf.length;
  }
  return n;
};
const only = opt('only', null)?.split(',');
let bones = null;
if (!has('anims-only')) {
  for (const [tier, names] of Object.entries(AVATARS)) {
    for (const name of names) {
      if (only && !only.includes(name)) continue;
      const t0 = Date.now();
      const r = await page.evaluate(([n, o]) => window.__rbAvatar(n, o), [name, TIERS[tier]]);
      const bytes = write(r.files);
      const { log, boneNames, ...meta } = r.meta;
      bones = boneNames;
      index.avatars[name] = { ...meta, tier, bytes, files: Object.keys(r.files) };
      console.log(`${name} [${tier}]: ${(bytes / 1024).toFixed(0)} KB, ${meta.verts} verts, ${meta.tris} tris, ${Date.now() - t0} ms`);
      for (const l of log) console.log('   ', l);
    }
  }
}
if (!has('no-anims')) {
  if (!bones) {
    const r = await page.evaluate(() => window.__rbAvatar('Male_Adult_01', { tex: 64, ntex: 64, hair: 64 }));
    bones = r.meta.boneNames;
  }
  for (const g of ['m', 'f']) {
    const specs = CLIPS.filter((c) => fs.existsSync(path.join(SRC, 'anims', `${g}_${c.src}.max.fbx`)));
    const missing = CLIPS.filter((c) => !specs.includes(c)).map((c) => c.name);
    if (missing.length) console.log(`anims_${g}: no source for ${missing.join(', ')}`);
    const r = await page.evaluate(([g, specs, bones]) => window.__rbAnims(g, specs, bones), [g, specs, bones]);
    const bytes = write(r.files);
    index.anims[g] = { bytes, file: `anims_${g}.bin`, clips: specs.map((c) => c.name) };
    console.log(`anims_${g}: ${(bytes / 1024).toFixed(0)} KB`);
    for (const l of r.meta.log) console.log('   ', l);
  }
}
fs.writeFileSync(indexPath, JSON.stringify(index, null, 1));
fs.writeFileSync(
  path.join(OUT, 'LICENSE.txt'),
  `Microsoft Rocketbox Avatar Library
https://github.com/microsoft/Microsoft-Rocketbox

MIT License

Copyright (c) Microsoft Corporation.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Avatars and animations by Microsoft Rocketbox, converted for Center Court by
tools/build_people.mjs (metres, quantized GLB, resized WebP textures, a cloth
mask, resampled rotation-only animations; the face rig folded into the head).
`,
);
await browser.close();
