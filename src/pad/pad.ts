import Peer, { type DataConnection } from 'peerjs';
import { PEER_PREFIX, type PadMsg, type TvMsg } from '../net/Link.ts';

/**
 * The phone: a paddle. It reads the gyroscope and accelerometer, finds each swing's peak
 * (the fastest the phone turns is where it meets the ball) and sends it straight to the TV
 * with how hard it was and how much it moved upward. The TV answers with a buzz and a pop
 * on contact, the score, and whose serve it is.
 */

const BASE = import.meta.env.BASE_URL;
const PADDLES = ['paddle_a.webp', 'paddle_b.webp', 'paddle_c.webp'];
const app = document.getElementById('app')!;
const params = new URLSearchParams(location.search);
let room = (params.get('room') ?? '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
const store = (k: string, v?: string) => {
  try {
    if (v === undefined) return localStorage.getItem(k);
    localStorage.setItem(k, v);
  } catch { /* private mode */ }
  return null;
};
const myId = store('dink-id') ?? Math.random().toString(36).slice(2, 10);
store('dink-id', myId);
let name = store('dink-name') ?? '';
let paddle = +(store('dink-paddle') ?? 0) % PADDLES.length;

let conn: DataConnection | null = null;
let peer: Peer | null = null;
let slot = -1;
let color = '#ff8a1f';
let connected = false;

// ------------------------------------------------------------------------------------ screens
function joinScreen(err = '') {
  app.innerHTML = `
    <div class="join">
      <img class="logo" src="${BASE}art/logo.webp" alt="Dink Club" />
      <div class="h">Your phone is the paddle</div>
      <label class="f"><span>Room code</span><input id="code" maxlength="4" autocapitalize="characters" autocomplete="off" value="${room}" placeholder="ABCD" /></label>
      <label class="f"><span>Your name</span><input id="name" maxlength="14" autocomplete="nickname" value="${escapeHtml(name)}" placeholder="Name" /></label>
      <div class="pick">${PADDLES.map((p, i) => `<button class="pp ${i === paddle ? 'on' : ''}" data-i="${i}"><img src="${BASE}art/${p}" alt="" /></button>`).join('')}</div>
      <button id="go" class="go">Grab the paddle</button>
      <div class="err">${err}</div>
      <div class="fine">Motion sensors are used only to read your swings.</div>
    </div>`;
  app.querySelectorAll<HTMLButtonElement>('.pp').forEach((b) => (b.onclick = () => {
    paddle = +b.dataset.i!;
    store('dink-paddle', String(paddle));
    app.querySelectorAll('.pp').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
  }));
  (document.getElementById('go') as HTMLButtonElement).onclick = () => void go();
}

async function go() {
  room = (document.getElementById('code') as HTMLInputElement).value.toUpperCase().replace(/[^A-Z]/g, '');
  name = (document.getElementById('name') as HTMLInputElement).value.trim().slice(0, 14);
  store('dink-name', name);
  if (room.length !== 4) return joinScreen('Enter the 4-letter code on the TV.');
  unlockAudio();
  const ok = await askMotion();
  if (!ok) return joinScreen('Motion access is needed to swing. Allow it in the prompt (Safari: aA › Website Settings › Motion).');
  void wakeLock();
  paddleScreen();
  connect();
}

function paddleScreen() {
  app.innerHTML = `
    <div class="pad" id="pad">
      <div class="top"><span class="dot" id="dot"></span><span id="who">Connecting…</span><button class="ic" id="pause" aria-label="Pause"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg></button></div>
      <div class="msg"><div class="t" id="t">Connecting to the TV…</div><div class="s" id="s">Room ${room}</div></div>
      <div class="paddle" id="paddle"><img src="${BASE}art/${PADDLES[paddle]}" alt="" /><div class="grip"></div></div>
      <div class="read"><span id="last">Give it a swing to test</span><button class="mini" id="center">Recenter</button></div>
      <div class="meter"><div class="fill" id="fill"></div></div>
      <div class="row"><button class="btn" id="start">Play</button><button class="btn ghost" id="again">Rematch</button></div>
      <div class="hint">Hold it like a paddle, screen toward the TV. Soft = dink · hard = drive · brush up = topspin · chop down = slice · open face + up = lob. Where the face points is where it goes.</div>
    </div>`;
  (document.getElementById('pause') as HTMLButtonElement).onclick = () => send({ t: 'tap', what: 'pause' });
  (document.getElementById('start') as HTMLButtonElement).onclick = () => send({ t: 'tap', what: 'start' });
  (document.getElementById('again') as HTMLButtonElement).onclick = () => send({ t: 'tap', what: 'again' });
  (document.getElementById('center') as HTMLButtonElement).onclick = () => { recenter(); setLast('Recentered — aim is straight ahead', 0); };
}

function setLast(text: string, power: number) {
  const el = document.getElementById('last');
  if (el) el.textContent = power ? `${text} · ${Math.round(power * 100)}%` : text;
}

function setMsg(t: string, s = '') {
  const a = document.getElementById('t'), b = document.getElementById('s');
  if (a) a.textContent = t;
  if (b) b.textContent = s;
}

// ------------------------------------------------------------------------------------ link
function connect() {
  // stale peers / connections are ignored from here on
  conn = null;
  peer?.destroy();
  const p = new Peer({ debug: 0 });
  peer = p;
  p.on('open', () => {
    if (peer !== p) return;
    const c = p.connect(PEER_PREFIX + room, { reliable: true, serialization: 'json' });
    conn = c;
    c.on('open', () => {
      if (conn !== c) return;
      connected = true;
      send({ t: 'hello', id: myId, name, paddle });
    });
    c.on('data', (d) => { if (conn === c) onTv(d as TvMsg); });
    c.on('close', () => { if (conn === c) lost(); });
    c.on('error', () => { if (conn === c) lost(); });
  });
  p.on('error', (e) => {
    if (peer !== p) return;
    const type = (e as { type?: string }).type;
    if (type === 'peer-unavailable') { peer = null; p.destroy(); setMsg('No TV with that code', 'Check the code on the TV screen'); setTimeout(() => joinScreen(`Room ${room} not found.`), 1500); }
    else lost();
  });
}

let retry = 0;
function lost() {
  connected = false;
  setDot(false);
  setMsg('Reconnecting…', `Room ${room}`);
  clearTimeout(retry);
  retry = window.setTimeout(() => connect(), 1500);
}

function send(m: PadMsg) {
  if (conn && conn.open) conn.send(m);
}

function setDot(on: boolean) {
  const d = document.getElementById('dot');
  if (d) { d.style.background = on ? color : '#666'; d.classList.toggle('live', on); }
}

function onTv(m: TvMsg) {
  switch (m.t) {
    case 'welcome':
      slot = m.slot;
      color = m.color;
      document.documentElement.style.setProperty('--me', color);
      setDot(true);
      (document.getElementById('who') as HTMLElement).textContent = `${m.label} · ${name || 'Player'}`;
      setMsg('Connected', slot === 0 ? 'Press Play here or on the TV' : 'You’re player 2');
      break;
    case 'state':
      setMsg(m.text, m.sub ?? '');
      document.getElementById('pad')?.classList.toggle('serve', !!m.serve);
      break;
    case 'hit':
      buzz(m.power > 0.75 ? 45 : 22);
      setLast(m.label ?? m.shot, m.power);
      popSound(m.power, m.shot === 'dink' || m.shot === 'drop');
      flash(m.quality > 0.85 ? 'great' : 'ok');
      break;
    case 'whiff':
      flash('miss');
      break;
    case 'point':
      setMsg(m.won ? 'Point!' : 'Their point', m.call);
      if (m.won) buzz([20, 60, 20]);
      break;
    case 'ping':
      send({ t: 'pong', k: m.k, tp: performance.now() / 1000 });
      break;
    case 'full':
      setMsg('The court is full', 'Two paddles are already connected');
      break;
  }
}

// ------------------------------------------------------------------------------------ swing detection
async function askMotion(): Promise<boolean> {
  type Req = { requestPermission?: () => Promise<string> } | undefined;
  const DME = window.DeviceMotionEvent as unknown as Req;
  const DOE = window.DeviceOrientationEvent as unknown as Req;
  if (!DME) return false;
  try {
    // iOS: both prompts must start inside the tap (no await before them)
    const asks: Promise<string>[] = [];
    if (typeof DME.requestPermission === 'function') asks.push(DME.requestPermission());
    if (DOE && typeof DOE.requestPermission === 'function') asks.push(DOE.requestPermission().catch(() => 'denied'));
    const res = await Promise.all(asks);
    if (res.length && res[0] !== 'granted') return false;
  } catch {
    return false;
  }
  addEventListener('devicemotion', onMotion);
  addEventListener('deviceorientation', onOrient);
  return true;
}

/**
 * The paddle's face: the screen's normal in the earth frame (x east, y north, z up), from the
 * fused orientation (W3C Z-X'-Y'' Euler angles). `faceUp` is how far the face is tilted to the
 * sky (an open face), `heading` the compass direction it points. While the phone is held still
 * the heading drifts toward "forward" (facing the TV), so aim is measured relative to it.
 */
const face = { up: 0, heading: 0, ok: false };
let fwdHeading: number | null = null;
let calmSince = 0;
const D2R = Math.PI / 180;
function onOrient(e: DeviceOrientationEvent) {
  if (e.alpha === null || e.beta === null || e.gamma === null) return;
  const a = e.alpha * D2R, b = e.beta * D2R, g = e.gamma * D2R;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(g), sg = Math.sin(g);
  // third column of R = Rz(a)·Rx(b)·Ry(g): the device z axis (out of the screen) in earth coordinates
  const nx = ca * sg + sa * sb * cg;
  const ny = sa * sg - ca * sb * cg;
  const nz = cb * cg;
  face.up = nz;
  face.heading = Math.atan2(nx, ny);
  face.ok = true;
  const now = performance.now() / 1000;
  if (gyro < 45) {
    if (!calmSince) calmSince = now;
    // a still, roughly upright paddle: that's the ready position, facing the TV
    if (now - calmSince > 0.5 && Math.abs(nz) < 0.6) fwdHeading = fwdHeading === null ? face.heading : fwdHeading + wrap(face.heading - fwdHeading) * 0.04;
  } else calmSince = 0;
}
function wrap(x: number) {
  return Math.atan2(Math.sin(x), Math.cos(x));
}
function recenter() {
  if (face.ok) fwdHeading = face.heading;
}

const START = 230; // deg/s: a swing has begun
const COOLDOWN = 0.3;
let gyro = 0;
let swinging = false, cool = 0;
let lastT = 0;
// the swing so far: gyro magnitude samples (for a sub-frame peak) and the vertical speed
const samples: { t: number; g: number; up: number; face: number; head: number }[] = [];
let vUp = 0;

function onMotion(e: DeviceMotionEvent) {
  const now = performance.now() / 1000;
  const dt = lastT ? Math.min(0.05, now - lastT) : 1 / 60;
  lastT = now;
  const r = e.rotationRate;
  const a = e.acceleration, ag = e.accelerationIncludingGravity;
  if (!r) return;
  const g = Math.hypot(r.alpha ?? 0, r.beta ?? 0, r.gamma ?? 0);
  gyro = g;
  // vertical acceleration: the linear acceleration along "up" (gravity's reaction = with − without)
  let up = 0;
  if (a && ag && a.x !== null && ag.x !== null) {
    const gx = (ag.x ?? 0) - (a.x ?? 0), gy = (ag.y ?? 0) - (a.y ?? 0), gz = (ag.z ?? 0) - (a.z ?? 0);
    const gl = Math.hypot(gx, gy, gz) || 1;
    up = (((a.x ?? 0) * gx + (a.y ?? 0) * gy + (a.z ?? 0) * gz) / gl) * upSign;
  }
  // a leaky integral: the paddle's vertical speed (leak keeps drift out between swings)
  vUp = vUp * Math.exp(-dt / (swinging ? 0.6 : 0.15)) + up * dt;
  if (!swinging) {
    samples.length = 0;
    if (g > START && now > cool) swinging = true;
  }
  if (!swinging) return;
  samples.push({ t: now, g, up: vUp, face: face.up, head: face.heading });
  const n = samples.length;
  const k = samples.reduce((bi, s, i) => (s.g > samples[bi].g ? i : bi), 0);
  // past the peak (falling off, or held there too long): the contact
  if (n - 1 > k && (g < samples[k].g * 0.8 || now - samples[k].t > 0.07 || n > 30)) {
    swinging = false;
    cool = now + COOLDOWN;
    // parabolic fit through the peak sample and its neighbours: when it really peaked
    let tPeak = samples[k].t, gPeak = samples[k].g;
    if (k > 0 && k < n - 1) {
      const y0 = samples[k - 1].g, y1 = samples[k].g, y2 = samples[k + 1].g;
      const den = y0 - 2 * y1 + y2;
      if (den < 0) {
        const off = THREEclamp((0.5 * (y0 - y2)) / den, -0.5, 0.5);
        const h = (samples[k + 1].t - samples[k - 1].t) / 2;
        tPeak += off * h;
        gPeak = y1 - 0.25 * (y0 - y2) * off;
      }
    }
    const pk = samples[k];
    const power = THREEclamp((gPeak - START) / 1350, 0, 1);
    const lift = THREEclamp(pk.up / 2.4, -1, 1);
    const aim = fwdHeading === null || !face.ok ? null : THREEclamp(wrap(pk.head - fwdHeading) / (40 * D2R), -1.6, 1.6);
    send({ t: 'swing', power, lift, peak: Math.round(gPeak), tp: tPeak, face: face.ok ? pk.face : null, aim, ago: now - tPeak });
    meter(power);
    vUp = 0;
  }
}
function THREEclamp(x: number, a: number, b: number) {
  return Math.max(a, Math.min(b, x));
}

// the sign of "up": at rest, accelerationIncludingGravity should point up (iOS) — calibrate on the first quiet samples
let upSign = 1;
addEventListener('devicemotion', function cal(e) {
  const ag = e.accelerationIncludingGravity;
  if (!ag || ag.y === null) return;
  // phones held upright: +y up reads ~+9.8 on iOS, ~−9.8 on some Androids
  if (Math.abs(ag.y ?? 0) > 7) {
    upSign = (ag.y ?? 0) > 0 ? 1 : -1;
    removeEventListener('devicemotion', cal);
  }
});

// ------------------------------------------------------------------------------------ feedback
function meter(p: number) {
  const f = document.getElementById('fill');
  if (!f) return;
  f.style.transition = 'none';
  f.style.width = `${Math.round(8 + p * 92)}%`;
  void f.offsetWidth;
  f.style.transition = 'width 0.8s ease 0.25s';
  f.style.width = '0%';
  const pd = document.getElementById('paddle');
  pd?.classList.remove('swing');
  void pd?.offsetWidth;
  pd?.classList.add('swing');
}

function flash(kind: 'great' | 'ok' | 'miss') {
  const p = document.getElementById('pad');
  if (!p) return;
  p.classList.remove('great', 'ok', 'miss');
  void p.offsetWidth;
  p.classList.add(kind);
}

/** vibration where the browser has it; on iOS Safari (no vibrate) a switch control's haptic tick */
let hapticEl: HTMLLabelElement | null = null;
function buzz(pattern: number | number[]) {
  if (navigator.vibrate && navigator.vibrate(pattern)) return;
  if (!hapticEl) {
    hapticEl = document.createElement('label');
    hapticEl.style.cssText = 'position:fixed;left:-100px;top:0;opacity:0;';
    hapticEl.innerHTML = '<input type="checkbox" switch />';
    document.body.append(hapticEl);
  }
  hapticEl.click();
}

let actx: AudioContext | null = null;
let pops: AudioBuffer[] = [];
function unlockAudio() {
  if (actx) return;
  actx = new AudioContext();
  void actx.resume();
  for (const n of ['pop1', 'pop3']) {
    fetch(`${BASE}sfx/${n}.mp3`).then((r) => r.arrayBuffer()).then((b) => actx!.decodeAudioData(b)).then((buf) => pops.push(buf)).catch(() => null);
  }
}
function popSound(power: number, soft: boolean) {
  if (!actx || !pops.length) return;
  const src = actx.createBufferSource();
  src.buffer = pops[soft && pops[1] ? 1 : 0];
  src.playbackRate.value = 0.95 + Math.random() * 0.1;
  const g = actx.createGain();
  g.gain.value = 0.4 + power * 0.6;
  src.connect(g).connect(actx.destination);
  src.start();
}

async function wakeLock() {
  try {
    const wl = (navigator as unknown as { wakeLock?: { request: (t: string) => Promise<unknown> } }).wakeLock;
    await wl?.request('screen');
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void wl?.request('screen'); });
  } catch { /* fine */ }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

// desktop testing: no motion sensors → space bar / tap the paddle to "swing"
addEventListener('keydown', (e) => { if (e.code === 'Space' && connected) { send({ t: 'swing', power: e.shiftKey ? 0.9 : 0.5, lift: 0, peak: 0 }); meter(0.5); } });

joinScreen();
// tapping the paddle also swings (for desktop tests and accessibility)
app.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (connected && t.closest('#paddle')) { send({ t: 'swing', power: 0.45, lift: 0, peak: 0 }); meter(0.45); }
});
