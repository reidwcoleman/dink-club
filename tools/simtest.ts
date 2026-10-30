// node tools/simtest.ts — sanity checks of the ball model and the shot solver (no browser)
import { BallSim, predict, spinFor, v3 } from '../src/sim/Ball.ts';
import { solveShot } from '../src/sim/Shot.ts';
import { HL, SERVICE } from '../src/sim/dims.ts';

const kmh = (v: number) => (v * 3.6).toFixed(0);
function show(name: string, p0: ReturnType<typeof v3>, target: { x: number; z: number }, spec: Parameters<typeof solveShot>[2], surface: 'hard' | 'clay' | 'grass' = 'hard') {
  const t0 = performance.now();
  const s = solveShot(p0, target, spec, surface);
  const ms = performance.now() - t0;
  const pr = predict(p0, s.v, s.w, surface, 4, 1 / 240, 2);
  const b1 = pr.events.find((e) => e.kind === 'bounce');
  const net = pr.events.find((e) => e.kind === 'net');
  // height at the far baseline + 1 m after the bounce
  let apex2 = 0;
  let passedBounce = false;
  for (const p of pr.pts) {
    if (b1 && p.t > b1.t) passedBounce = true;
    if (passedBounce) apex2 = Math.max(apex2, p.y);
  }
  const b2 = pr.events.filter((e) => e.kind === 'bounce')[1];
  console.log(
    `${name.padEnd(22)} ${surface.padEnd(5)} speed ${kmh(s.speed)} km/h elev ${((s.elev * 180) / Math.PI).toFixed(1)}° ok=${s.ok} land (${s.land.x.toFixed(2)}, ${s.land.z.toFixed(2)}) clear ${s.netClear.toFixed(2)} m` +
      ` | sim bounce ${b1 && b1.kind === 'bounce' ? `(${b1.x.toFixed(2)}, ${b1.z.toFixed(2)}) t=${b1.t.toFixed(2)}s out-speed ${kmh(b1.speed)}` : 'none'} kick-apex ${apex2.toFixed(2)} m` +
      `${b2 && b2.kind === 'bounce' ? ` 2nd bounce z=${b2.z.toFixed(1)}` : ''}${net ? ' NET:' + JSON.stringify(net) : ''} [${ms.toFixed(1)} ms]`,
  );
}

// baseline rallies (near player at z = +12.5 hits to the far court)
const p = v3(0.6, 0.95, HL + 0.8);
show('forehand topspin', p, { x: -2.5, z: -HL + 2.0 }, { speed: 34, rpm: 2600 });
show('forehand flat', p, { x: -2.5, z: -HL + 2.0 }, { speed: 40, rpm: 900 });
show('slice backhand', p, { x: 2.5, z: -HL + 2.5 }, { speed: 26, rpm: -2400 });
show('lob', p, { x: 0, z: -HL + 1.5 }, { speed: 22, rpm: 1500, arc: 'high' });
show('drop shot', p, { x: 1, z: -2.5 }, { speed: 12, rpm: -2000, clear: 0.1 });
for (const surf of ['hard', 'clay', 'grass'] as const) show('topspin', p, { x: -2.5, z: -HL + 2.0 }, { speed: 34, rpm: 2600 }, surf);
for (const surf of ['hard', 'clay', 'grass'] as const) show('slice', p, { x: 2.5, z: -HL + 2.5 }, { speed: 26, rpm: -2400 }, surf);
// serves: from the deuce side (x = +0.6) into the far deuce box (x < 0 … −4.1, z in −6.4 … 0)
const sv = v3(0.5, 2.75, HL + 0.05);
show('flat serve T', sv, { x: -0.3, z: -SERVICE + 0.4 }, { speed: 58, rpm: 400, clear: 0.02 });
show('flat serve wide', sv, { x: -3.6, z: -SERVICE + 0.6 }, { speed: 56, rpm: 400, clear: 0.02 });
show('kick serve', sv, { x: -2.0, z: -SERVICE + 1.0 }, { speed: 44, rpm: 3200, side: 800, clear: 0.2 });
show('slice serve wide', sv, { x: -3.8, z: -SERVICE + 0.8 }, { speed: 48, rpm: 800, side: -2400, clear: 0.1 });

// free flight check: 30 m/s flat launch, 10° — drop over distance
const b = new BallSim();
b.set(v3(0, 1, 0), v3(0, Math.sin(0.17) * 30, Math.cos(0.17) * 30), spinFor(0, 1, 0));
while (b.bounces === 0 && b.t < 5) b.step(1 / 120);
console.log(`no-spin 30 m/s @10°: first bounce at z=${b.p.z.toFixed(2)} after ${b.t.toFixed(2)} s`);
