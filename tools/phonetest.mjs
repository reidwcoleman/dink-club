// End-to-end phone test: a TV page and a phone page (pad.html) linked over PeerJS/WebRTC.
// The phone gets synthetic devicemotion swings (gyro ramps) timed off the TV's plan.
//   node tools/phonetest.mjs [seconds=40] [base=http://localhost:5230/]
import { chromium } from 'playwright-core';
const [secs = '40', base = 'http://localhost:5230/'] = process.argv.slice(2);
const SP = process.env.SP || '.';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext();
const tv = await ctx.newPage();
await tv.setViewportSize({ width: 1280, height: 720 });
const errs = [];
for (const [n, p] of [['tv', tv]]) p.on('pageerror', (e) => errs.push(n + ': ' + e.message));
await tv.goto(base + '?q=low');
await tv.waitForFunction(() => window.__ready === true && window.__cc.lobby.code, null, { timeout: 120000 });
const code = await tv.evaluate(() => window.__cc.lobby.code);
console.log('room', code);
const phone = await ctx.newPage();
phone.on('pageerror', (e) => errs.push('phone: ' + e.message));
phone.on('console', (m) => { if (m.type() === 'error') errs.push('phone console: ' + m.text().slice(0, 200)); });
await phone.setViewportSize({ width: 390, height: 844 });
await phone.goto(base + 'pad.html?room=' + code);
await phone.fill('#name', 'Reid');
await phone.click('#go');
await phone.waitForFunction(() => document.getElementById('who')?.textContent?.startsWith('P1'), null, { timeout: 30000 });
console.log('phone says:', await phone.evaluate(() => document.getElementById('t').textContent + ' / ' + document.getElementById('s').textContent));
await tv.waitForFunction(() => window.__cc.lobby.name(0) === 'Reid', null, { timeout: 10000 });
console.log('tv sees P1:', await tv.evaluate(() => window.__cc.lobby.name(0)), 'delay', await tv.evaluate(() => window.__cc.lobby.delay(0)));
await tv.screenshot({ path: SP + '/pt_menu.png' });
await phone.screenshot({ path: SP + '/pt_phone0.png' });
// the phone presses Play
await phone.click('#start');
await tv.waitForFunction(() => window.__cc.game?.state && window.__cc.game.state !== 'idle', null, { timeout: 60000 });
console.log('game started');
// a real-ish swing: gyro magnitude rising to a peak and falling over ~120 ms
// the phone held still and upright between swings (the orientation sensor sets "forward")
const idle = setInterval(() => phone.evaluate(() => {
  if (window.__sw) return;
  window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 30, beta: 88, gamma: 0 }));
  window.dispatchEvent(new DeviceMotionEvent('devicemotion', { rotationRate: { alpha: 2, beta: 2, gamma: 2 }, acceleration: { x: 0, y: 0, z: 0 }, accelerationIncludingGravity: { x: 0, y: 9.8, z: 0 }, interval: 16 }));
}).catch(() => {}), 50);
// a swing: gyro rising to a peak and falling over ~120 ms; `up` m/s² of vertical push (brush up = topspin),
// `tilt` degrees the face opens to the sky, `turn` degrees the face points right of forward
async function swing(power, up = 0, tilt = 0, turn = 0) {
  const peak = 240 + power * 1350;
  await phone.evaluate(async ([peak, up, tilt, turn]) => {
    window.__sw = true;
    const steps = [0.3, 0.6, 0.85, 1, 0.75, 0.5, 0.2];
    for (const k of steps) {
      const g = peak * k;
      window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 30 - turn * k, beta: 88 - tilt, gamma: 0 }));
      window.dispatchEvent(new DeviceMotionEvent('devicemotion', { rotationRate: { alpha: g * 0.2, beta: g * 0.3, gamma: g * 0.93 }, acceleration: { x: 3, y: up, z: 0 }, accelerationIncludingGravity: { x: 3, y: 9.8 + up, z: 0 }, interval: 16 }));
      await new Promise((r) => setTimeout(r, 16));
    }
    window.__sw = false;
  }, [peak, up, tilt, turn]);
}
const KINDS = [[0.85, 25, 0, 0, 'topspin drive'], [0.5, -25, 30, 0, 'slice'], [0.15, 6, 20, 0, 'dink'], [0.5, 30, 55, 0, 'lob'], [0.6, 0, 0, 30, 'aim right'], [0.6, 0, 0, -30, 'aim left']];
let kindI = 0;
const t0 = Date.now();
let swings = 0;
while (Date.now() - t0 < +secs * 1000) {
  const s = await tv.evaluate(() => {
    const g = window.__cc.game;
    const me = g.players[0];
    return { state: g.state, srv: g.match.server, stateT: g.stateT, tTo: me.plan ? me.plan.tContact - g.clock : null, committed: !!g.committed?.[0] };
  });
  if (s.state === 'preServe' && s.srv === 0 && s.stateT > 1) { await swing(0.5); swings++; await tv.waitForTimeout(400); continue; }
  if (s.state === 'rally' && s.tTo !== null && !s.committed && s.tTo < 0.12) {
    const k = KINDS[kindI++ % KINDS.length];
    console.log('swing as', k[4]);
    await swing(k[0], k[1], k[2], k[3]); swings++; await tv.waitForTimeout(200); continue;
  }
  await tv.waitForTimeout(15);
}
const out = await tv.evaluate(() => ({ log: window.__cc.game.log.slice(-40), score: window.__cc.game.match.score }));
console.log(out.log.filter((l) => /hit Reid|RALLY|early|miss|no swing/.test(l)).join('\n'));
console.log('phone last read:', await phone.evaluate(() => document.getElementById('last')?.textContent));
clearInterval(idle);
console.log('swings sent', swings, 'score', out.score);
await tv.screenshot({ path: SP + '/pt_game.png' });
await phone.screenshot({ path: SP + '/pt_phone1.png' });
console.log('errors', errs.slice(0, 10));
await browser.close();
