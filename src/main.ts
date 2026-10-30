import * as THREE from 'three';
import { Renderer, type Quality } from './render/Renderer.ts';
import { World } from './world/World.ts';
import type { SkyName } from './world/Sky.ts';
import { Crowd } from './people/Crowd.ts';
import { Game, ROSTER, type GameConfig } from './game/Game.ts';
import { Input } from './game/Input.ts';
import { HUD } from './ui/HUD.ts';
import { Menu, pauseOverlay, summaryOverlay, type MenuChoice } from './ui/Menu.ts';
import { Audio } from './audio/Audio.ts';
import type { Difficulty } from './game/AI.ts';
import type { StrokeKind } from './game/PlayerRig.ts';
import { Lobby, SLOT_COLORS } from './net/Link.ts';
import { GFX } from './render/gfx.ts';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('view') as HTMLCanvasElement;
const ui = document.getElementById('ui')!;
const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.1, 2000);
camera.position.set(0, 12, 30);
camera.lookAt(0, 0, 0);

const onTV = params.get('tv') === '1';
GFX.lite = onTV || params.get('lite') === '1';
const renderer = new Renderer(canvas, new THREE.Scene(), camera);
const world = new World(renderer.gl, 'palms');
renderer.renderPass.mainScene = world.scene;
renderer.liveScene = world.scene;
renderer.composer.passes.forEach((p) => ((p as unknown as { mainScene: THREE.Scene }).mainScene = world.scene));
// on the TV app (an Android TV box's GPU) start lighter; the renderer adapts its resolution from there
renderer.setQuality((params.get('q') as Quality) ?? (onTV ? 'low' : 'high'));
if (GFX.lite) {
  world.sky.sun.shadow.mapSize.set(1024, 1024);
  renderer.setLite(true);
}
const exMul = +(params.get('ex') ?? 1);

const input = new Input();
const audio = new Audio();
const hud = new HUD(ui);
hud.show(false);
const lobby = new Lobby();
let crowd: Crowd | null = null;
let game: Game | null = null;
let paused = false;
let pauseEl: HTMLElement | null = null;
let summaryEl: HTMLElement | null = null;
let inMatch = false;
const choice: MenuChoice = {
  level: params.get('level') ?? 'club',
  format: params.get('format') ?? 'classic11',
  sky: params.get('sky') ?? 'sunset',
  players: params.get('players') ?? '1',
};
const menu = new Menu(ui, choice);
menu.busy(true);
menu.setStatus('Building the club…');

// ---- phones
lobby.onChange = () => {
  if (lobby.status === 'ready') menu.setJoin(lobby.code, lobby.joinUrl);
  if (lobby.status === 'offline') menu.setOffline();
  const names = [lobby.name(0), lobby.name(1)];
  menu.setSlots(names);
  const two = choice.players === '2';
  hud.setPads(names.slice(0, two ? 2 : 1).map((n, i) => ({ label: `P${i + 1}`, name: n, color: SLOT_COLORS[i] })), lobby.code);
  if (names[1] && choice.players === '1') {
    // a second phone joined: offer head to head
    menu.setStatus('Two phones connected — pick “Head to head” to play each other.');
  }
  for (let i = 0; i < 2; i++) if (lobby.connected(i)) sendState(i);
};
lobby.onSwing = (slot, s) => {
  audio.start();
  input.push(slot, { at: s.at, power: s.power, lift: s.lift, face: s.face, aim: s.aim, from: 'phone' });
  if (!inMatch) menu.swingTest(slot, s.power);
  if (summaryEl && game?.match?.winner !== null) rematch();
};
lobby.onTap = (slot, what) => {
  audio.start();
  if (what === 'start' && !inMatch && !menu.root.classList.contains('busy')) void play(choice);
  else if (what === 'pause') togglePause();
  else if (what === 'again' && summaryEl) rematch();
  void slot;
};
void lobby.open();

function sendState(slot: number) {
  if (!inMatch) lobby.send(slot, { t: 'state', text: 'Connected', sub: slot === 0 ? 'Start the game on the TV — or tap Play' : 'You’re player 2', serve: false });
}

async function boot() {
  await world.build(choice.sky as SkyName);
  menu.setStatus('Filling the bleachers…');
  crowd = new Crowd();
  await crowd.bake(renderer.gl, (f) => menu.setStatus(`Filling the bleachers… ${Math.round(f * 100)}%`));
  crowd.populate(world.club.seats, 0.62);
  world.scene.add(crowd.mesh);
  game = new Game(world, camera, input, hud, audio, crowd);
  game.onDof = (on, focus, range) => renderer.setDof(on, focus, (range ?? 3) * 1.6, 1.8);
  game.onPadEvent = (slot, kind, data) => {
    if (kind === 'hit') lobby.send(slot, { t: 'hit', power: data.power as number, quality: data.quality as number, shot: data.shot as string, label: data.label as string });
    else if (kind === 'whiff') lobby.send(slot, { t: 'whiff' });
    else lobby.send(slot, { t: 'point', won: !!data.won, call: data.call as string });
  };
  game.onStatus = (slot, text, sub, serve) => lobby.send(slot, { t: 'state', text, sub, serve, score: game?.match ? `${game.match.score[slot]}-${game.match.score[1 - slot]}` : '' });
  game.dir.cut('intro');
  world.finalize();
  renderer.enableAO(world.scene);
  menu.setStatus('');
  menu.busy(false);
  start();
  const auto = params.get('auto');
  if (auto) void play(choice, auto === 'demo');
}

function formatOf(f: string): Pick<GameConfig, 'to' | 'games' | 'rally'> {
  if (f === 'rally15') return { to: 15, games: 1, rally: true };
  if (f === 'quick7') return { to: 7, games: 1, rally: false };
  if (f === 'bo3') return { to: 11, games: 3, rally: false };
  return { to: 11, games: 1, rally: false };
}

async function play(c: MenuChoice, demo = false) {
  if (!game) return;
  audio.start();
  audio.music(0.25);
  menu.busy(true);
  menu.setStatus('Players walking on…');
  const two = c.players === '2';
  const near = Math.floor(Math.random() * ROSTER.length);
  let far = (near + 1 + Math.floor(Math.random() * (ROSTER.length - 1))) % ROSTER.length;
  if (far === near) far = (near + 1) % ROSTER.length;
  const names: [string, string] = [lobby.name(0) ?? (demo ? ROSTER[near].name : 'You'), two ? lobby.name(1) ?? 'Player 2' : ROSTER[far].name];
  await game.setup({ level: c.level as Difficulty, players: two ? 2 : 1, ...formatOf(c.format), near, far, demo }, names, [lobby.paddle(0), two ? lobby.paddle(1) : 1 + Math.floor(Math.random() * 2)]);
  world.scene.environment = null;
  world.sky.captureEnv(world.dynamic);
  menu.hide();
  hud.show(true);
  inMatch = true;
  lobby.onChange?.();
  game.begin();
  game.onMatchOver = (m) => {
    setTimeout(() => {
      summaryEl = summaryOverlay(ui, m, game!.names, rematch, () => location.reload());
      for (let i = 0; i < 2; i++) lobby.send(i, { t: 'state', text: m.winner === i ? 'You win!' : 'Game over', sub: 'Tap Rematch or swing to play again', serve: false });
    }, 3800);
  };
}

function rematch() {
  summaryEl?.remove();
  summaryEl = null;
  void play(choice);
}

menu.onPlay = (c) => void play(c);
menu.onChange = (key, c) => {
  audio.start();
  audio.music(1);
  if (key === 'sky') void world.setSky(c.sky as SkyName);
};
// browsers keep audio off until someone clicks or presses a key on the TV's page
let soundOn = false;
const unlock = () => {
  if (soundOn) return;
  soundOn = true;
  audio.start();
  if (!inMatch) audio.music(1);
  document.body.classList.add('sound-on');
};
addEventListener('pointerdown', unlock);
addEventListener('keydown', unlock);

function togglePause() {
  if (!game || game.state === 'idle') return;
  paused = !paused;
  if (paused) pauseEl = pauseOverlay(ui, () => togglePause(), () => location.reload());
  else {
    pauseEl?.remove();
    pauseEl = null;
  }
}
input.onPause = togglePause;
// the TV remote's Back button (from the Android TV app)
(window as unknown as Record<string, unknown>).__tvBack = () => {
  if (summaryEl) { location.reload(); return; }
  if (inMatch) togglePause();
};
if (onTV) {
  document.body.classList.add('tv', 'sound-on');
  audio.start();
}
input.onCamera = () => {
  if (game) game.dir.pref = (game.dir.pref + 1) % 3;
};

let last = performance.now();
let time = 0;
let raf = 0;
let held = false;
function frame(now: number) {
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;
  if (!held) step(dt);
  raf = requestAnimationFrame(frame);
}
function step(dt: number) {
  time += dt;
  const gdt = paused ? 0 : dt;
  world.update(gdt, time);
  if (game) {
    if (game.state === 'idle') game.dir.update(dt, new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3());
    else game.update(gdt);
  }
  crowd?.update(gdt, camera);
  if (crowd) crowd.uniforms.uFlash.value = 0;
  world.marks.flush();
  renderer.setExposure(world.sky.exposure * exMul);
  renderer.render(dt);
  renderer.adapt(dt, time);
}
function start() {
  last = performance.now();
  raf = requestAnimationFrame(frame);
  (window as unknown as Record<string, unknown>).__ready = true;
}

// ---- debug / headless hooks
const W = window as unknown as Record<string, unknown>;
W.__cc = { world, renderer, camera, THREE, input, lobby, get game() { return game; }, get crowd() { return crowd; } };
W.__pump = (n: number, dt = 1 / 60) => {
  cancelAnimationFrame(raf);
  for (let i = 0; i < n; i++) step(dt);
  last = performance.now();
  raf = requestAnimationFrame(frame);
};
W.__cam = (x: number | null, y = 0, z = 0, tx = 0, ty = 0, tz = 0, fov?: number) => {
  if (!game) return;
  if (x === null) { game.dir.fixed = null; return; }
  game.dir.fixed = { pos: new THREE.Vector3(x, y, z), look: new THREE.Vector3(tx, ty, tz), fov: fov ?? camera.fov };
};
W.__sky = (n: SkyName) => world.setSky(n);
W.__hold = (on: boolean) => { held = on; };
/** a stand-in phone for tests: swings at the right moment with the given power (and a timing error) */
W.__autoHuman = (power = 0.5, lift = 0, jitter = 0.05) => {
  const tick = () => {
    const g = game;
    if (!g || !g.human.human) return;
    const me = g.human;
    const now = performance.now() / 1000;
    if (g.state === 'preServe' && g['serverIdx' as keyof Game] === 0 && g.stateT > 0.8) input.push(0, { at: now, power: 0.6, lift: 0.3, from: 'keys' });
    const pl = me.plan;
    if (g.state === 'rally' && pl && !(g as unknown as { committed: unknown[] }).committed[0]) {
      const tTo = pl.tContact - g.clock;
      if (tTo < 0.05 + Math.random() * 0.02) input.push(0, { at: now + (Math.random() - 0.5) * 2 * jitter, power: typeof power === 'number' ? power : Math.random(), lift, from: 'keys' });
    }
  };
  const orig = W.__pump as (n: number, dt?: number) => void;
  W.__pump = (n: number, dt = 1 / 60) => { for (let i = 0; i < n; i++) { tick(); orig(1, dt); } };
  setInterval(tick, 16);
};
W.__play = (demo = true) => play(choice, demo);
W.__pose = (kind: StrokeKind | null, phase: number, cx = 0.6, cy = 0.6, cz = 6.4) => {
  const r = game?.players?.[0]?.rig;
  if (!r) return;
  if (!kind) { r.cancelStroke(); r.debugPhase = null; return; }
  r.swing(kind, 0.5, new THREE.Vector3(cx, cy, cz));
  r.debugPhase = phase;
};

boot().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<pre style="position:fixed;top:0;left:0;color:#f66;padding:16px;white-space:pre-wrap">${String(e?.stack ?? e)}</pre>`);
});
