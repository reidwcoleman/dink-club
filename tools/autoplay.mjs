// Plays a match headless with a stand-in phone (window.__autoHuman) and prints the event log.
//   node tools/autoplay.mjs [seconds=60] [power=rand|0.5] [jitter=0.05] [url params]
import { chromium } from 'playwright-core';
const [secs = '60', power = 'rand', jitter = '0.05', extra = ''] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
await page.goto(`http://localhost:5230/?auto=play&q=low&${extra}`);
await page.waitForFunction(() => window.__ready === true && window.__cc.game?.state !== 'idle', null, { timeout: 120000 });
await page.evaluate(([p, j]) => window.__autoHuman(p === 'rand' ? 'rand' : +p, 0, +j), [power, jitter]);
await page.waitForTimeout(+secs * 1000);
const out = await page.evaluate(() => {
  const g = window.__cc.game;
  return { log: g.log.slice(-60), score: g.match.score, games: g.match.games, stats: g.match.stats, state: g.state };
});
console.log(out.log.join('\n'));
console.log('score', out.score, 'games', out.games, 'state', out.state);
console.log(JSON.stringify(out.stats));
console.log('errors', errs.slice(0, 10));
await browser.close();
