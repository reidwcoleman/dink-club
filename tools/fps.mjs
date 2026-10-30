// Real-loop fps (rAF, presented frames): node tools/fps.mjs [--scale 0.7] [--secs 5] [--url ...]
import { chromium } from 'playwright-core';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: +opt('w', 1440), height: +opt('h', 900) }, deviceScaleFactor: +opt('dpr', 2) });
page.setDefaultTimeout(300000);
await page.goto(`http://localhost:5230${opt('url', '/?auto=demo')}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true && window.__cc.game && window.__cc.game.state !== 'idle', null, { timeout: 180000 });
for (const scale of opt('scales', '1,0.85,0.7,0.55').split(',').map(Number)) {
  const r = await page.evaluate(async ([scale, secs, freeze]) => {
    const cc = window.__cc, R = cc.renderer;
    R.adaptive = false; R.scale = scale; R.resize();
    if (freeze) { cc.game.update = () => {}; window.__cam(0, 8.4, 26.8, 0, 0, 0.6, 38); }
    await new Promise((res) => setTimeout(res, 800));
    let n = 0; const t0 = performance.now();
    const dts = [];
    let last = t0;
    await new Promise((res) => { const f = (t) => { n++; dts.push(t - last); last = t; if (t - t0 < secs * 1000) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
    dts.sort((a, b) => a - b);
    return { scale, px: `${R.gl.domElement.width}x${R.gl.domElement.height}`, fps: +(n / secs).toFixed(1), p50: +dts[Math.floor(dts.length * 0.5)].toFixed(1), p90: +dts[Math.floor(dts.length * 0.9)].toFixed(1) };
  }, [scale, +opt('secs', 4), opt('freeze', '1') === '1']);
  console.log(JSON.stringify(r));
}
await browser.close();
