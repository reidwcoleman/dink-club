// Headless screenshot of the game with system Chrome (GPU via Metal).
//   node tools/shot.mjs [--url "/?venue=harbour"] [--out shots/a.png] [--w 1600 --h 900] [--eval "js"] [--pump 30] [--wait 500]
// Several shots in one browser: --eval can be repeated with --out of the same count (pairs).
import { chromium } from 'playwright-core';

const args = process.argv.slice(2);
const all = (k) => args.flatMap((a, i) => (a === '--' + k ? [args[i + 1]] : []));
const opt = (k, d) => all(k)[0] ?? d;
const port = opt('port', '5230');
const url = opt('base', '') ? opt('base') + opt('url', '') : `http://localhost:${port}${opt('url', '/')}`;
const W = +opt('w', 1600), H = +opt('h', 900);
const evals = all('eval');
const outs = all('out');
if (!outs.length) outs.push('shots/shot.png');

const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: +opt('dpr', 1) });
const logs = [];
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' || m.type() === 'warning' || t.startsWith('[cc]')) logs.push(`[${m.type()}] ${t.slice(0, 400)}`);
});
page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));
page.setDefaultTimeout(180000);
const t0 = Date.now();
await page.goto(url, { waitUntil: 'load' });
try {
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });
} catch (e) {
  console.log('not ready:', e.message);
}
console.log(`ready in ${Date.now() - t0} ms`);
const pump = +opt('pump', 20);
for (let i = 0; i < outs.length; i++) {
  if (evals[i]) {
    const r = await page.evaluate(async (js) => {
      const v = await eval(js);
      return v === undefined ? undefined : JSON.stringify(v).slice(0, 2000);
    }, evals[i]);
    if (r !== undefined) console.log('eval →', r);
  }
  if (pump) await page.evaluate((n) => window.__pump && window.__pump(n), pump);
  await page.waitForTimeout(+opt('wait', 150));
  await page.screenshot({ path: outs[i] });
  console.log('saved', outs[i]);
}
for (const l of logs.slice(0, 40)) console.log(l);
await browser.close();
