import Peer, { type DataConnection } from 'peerjs';

/**
 * The TV ↔ phone link. The TV opens a PeerJS peer named after a four-letter room code; each
 * phone (pad.html?room=CODE) connects to it over WebRTC and becomes a paddle in a player slot.
 * Phones send swings the instant they peak; the TV pings every phone to know its one-way
 * delay and dates each swing back by it, so timing is judged at the moment you swung.
 */

export const PEER_PREFIX = 'dinkclub-v1-';
const LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ';

/** phone → TV */
export type PadMsg =
  | { t: 'hello'; id: string; name: string; paddle: number }
  | { t: 'swing'; power: number; lift: number; peak: number; ago?: number; tp?: number; face?: number | null; aim?: number | null; vel?: number[] | null; n?: number[] | null; hand?: number | null; id?: number | null; pre?: boolean }
  | { t: 'tap'; what: 'start' | 'pause' | 'again' }
  /** the phone's position in the room (m: x to the right, z toward the TV), from the app's camera tracking */
  | { t: 'pos'; x: number; z: number; vx?: number; vz?: number }
  /** the phone's angle, ~30 a second: its long edge (handle → head) and its screen normal, room frame */
  | { t: 'ori'; s: number[]; f: number[]; p?: number[] }
  | { t: 'pong'; k: number; tp?: number };

/** TV → phone */
export type TvMsg =
  | { t: 'welcome'; slot: number; color: string; label: string }
  | { t: 'state'; text: string; sub?: string; serve?: boolean; score?: string }
  | { t: 'hit'; power: number; quality: number; shot: string; label?: string }
  | { t: 'whiff' }
  | { t: 'point'; won: boolean; call: string }
  | { t: 'ping'; k: number }
  | { t: 'full' }
  /** how this game moves the players: 'body' asks the app to track where the phone is in the room */
  | { t: 'mode'; move: 'auto' | 'body' };

export const SLOT_COLORS = ['#ff8a1f', '#2fc4c0'];

interface Slot {
  conn: DataConnection;
  id: string;
  name: string;
  paddle: number;
  rtt: number[];
  /** clock offset samples (phone − TV) with their round trip: the lowest-rtt ones are trusted */
  offs: { off: number; rtt: number }[];
  pings: Map<number, number>;
}

export class Lobby {
  code = '';
  peer: Peer | null = null;
  readonly slots: (Slot | null)[] = [null, null];
  status: 'connecting' | 'ready' | 'offline' = 'connecting';
  onSwing: ((slot: number, s: { power: number; lift: number; at: number; face: number | null; aim: number | null; vel: number[] | null; n: number[] | null; hand: number | null; id: number | null; pre: boolean }) => void) | null = null;
  onTap: ((slot: number, what: string) => void) | null = null;
  onPos: ((slot: number, x: number, z: number, vx: number, vz: number) => void) | null = null;
  onOri: ((slot: number, shaft: number[], face: number[], pos: number[] | null) => void) | null = null;
  onChange: (() => void) | null = null;
  private pingK = 0;

  async open(): Promise<void> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = Array.from({ length: 4 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join('');
      const ok = await this.tryOpen(code);
      if (ok) {
        this.code = code;
        this.status = 'ready';
        this.openLan();
        this.onChange?.();
        setInterval(() => this.pingAll(), 1000);
        return;
      }
    }
    this.status = 'offline';
    this.onChange?.();
  }

  private tryOpen(code: string): Promise<boolean> {
    return new Promise((res) => {
      const peer = new Peer(PEER_PREFIX + code, { debug: 0 });
      const fail = () => { peer.destroy(); res(false); };
      const timer = setTimeout(fail, 9000);
      peer.on('open', () => {
        clearTimeout(timer);
        this.peer = peer;
        peer.on('connection', (c) => this.accept(c));
        peer.on('disconnected', () => peer.reconnect());
        res(true);
      });
      peer.on('error', (e) => {
        if ((e as { type?: string }).type === 'unavailable-id' || !this.peer) { clearTimeout(timer); fail(); }
      });
    });
  }

  get joinUrl(): string {
    const u = new URL('pad.html', location.href);
    // the TV app's own address too: the iPhone app talks to it directly (and keeps going locked)
    const lan = lanBridge()?.address();
    u.search = `?room=${this.code}` + (lan ? `&lan=${lan}` : '');
    u.hash = '';
    return u.toString();
  }

  connected(slot: number): boolean {
    return !!this.slots[slot];
  }

  name(slot: number): string | null {
    return this.slots[slot]?.name ?? null;
  }

  paddle(slot: number): number {
    return this.slots[slot]?.paddle ?? slot;
  }

  /** one-way delay estimate for a slot (s) */
  delay(slot: number): number {
    const r = this.slots[slot]?.rtt;
    if (!r || !r.length) return 0.03;
    const s = [...r].sort((a, b) => a - b);
    return Math.min(0.15, s[Math.floor(s.length / 2)] / 2);
  }

  /** phone clock − TV clock (s), from the quickest recent pings (NTP-style) */
  offset(slot: number): number | null {
    const o = this.slots[slot]?.offs;
    if (!o || o.length < 2) return null;
    const best = [...o].sort((a, b) => a.rtt - b.rtt).slice(0, 3);
    return best.reduce((a, b) => a + b.off, 0) / best.length;
  }

  /**
   * Phones on the Wi-Fi through the TV app (LanPads.java): every datagram arrives as
   * window.__lan(from, msg); each sender becomes a connection like a WebRTC one, and goes quiet
   * (closed) after 8 s without a word. Swings come twice (UDP may drop one): `sid` dedupes them.
   */
  private lanConns = new Map<string, LanConn>();
  private openLan() {
    const b = lanBridge();
    if (!b) return;
    b.advertise(this.code);
    (window as unknown as Record<string, unknown>).__lan = (from: string, msg: PadMsg & { sid?: number }) => {
      let c = this.lanConns.get(from);
      if (!c || !c.open) {
        c = new LanConn(from, b, () => this.lanConns.delete(from));
        this.lanConns.set(from, c);
        this.accept(c as unknown as DataConnection);
      }
      c.receive(msg);
    };
  }

  send(slot: number, m: TvMsg) {
    const s = this.slots[slot];
    if (s && s.conn.open) s.conn.send(m);
  }

  broadcast(m: TvMsg) {
    for (let i = 0; i < this.slots.length; i++) this.send(i, m);
  }

  private accept(conn: DataConnection) {
    let slot = -1;
    conn.on('data', (raw) => {
      const m = raw as PadMsg;
      const now = performance.now() / 1000;
      if (m.t === 'hello') {
        // the same phone coming back gets its slot back; otherwise the first free slot
        slot = this.slots.findIndex((s) => s?.id === m.id);
        if (slot < 0) slot = this.slots.findIndex((s) => !s || !s.conn.open);
        if (slot < 0) { conn.send({ t: 'full' } satisfies TvMsg); setTimeout(() => conn.close(), 500); return; }
        const old = this.slots[slot];
        if (old && old.conn !== conn) old.conn.close();
        this.slots[slot] = { conn, id: m.id, name: (m.name || `Player ${slot + 1}`).slice(0, 14), paddle: m.paddle | 0, rtt: old?.rtt ?? [], offs: old?.offs ?? [], pings: new Map() };
        conn.send({ t: 'welcome', slot, color: SLOT_COLORS[slot], label: `P${slot + 1}` } satisfies TvMsg);
        this.onChange?.();
        return;
      }
      if (slot < 0 || this.slots[slot]?.conn !== conn) return;
      const s = this.slots[slot]!;
      if (m.t === 'pos') {
        const c = (v: unknown, k: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-k, Math.min(k, v)) : 0);
        if (Number.isFinite(m.x) && Number.isFinite(m.z)) this.onPos?.(slot, c(m.x, 20), c(m.z, 20), c(m.vx, 6), c(m.vz, 6));
        return;
      }
      if (m.t === 'ori') {
        const sv = vec3(m.s), fv = vec3(m.f);
        if (sv && fv) this.onOri?.(slot, sv, fv, vec3(m.p));
        return;
      }
      if (m.t === 'swing') {
        // when it peaked, on the TV's clock: from the phone's own timestamp and the synced offset
        // (falls back to arrival − half the round trip − how long the phone took to confirm the peak)
        let at = now - this.delay(slot) - Math.min(0.12, Math.max(0, +(m.ago ?? 0)));
        const off = this.offset(slot);
        if (off !== null && typeof m.tp === 'number') {
          const synced = m.tp - off;
          if (synced <= now + 0.02 && synced > now - 0.4) at = synced;
        }
        this.onSwing?.(slot, { power: clamp01(m.power), lift: Math.max(-1, Math.min(1, +m.lift || 0)), at, face: typeof m.face === 'number' ? m.face : null, aim: typeof m.aim === 'number' ? m.aim : null, vel: vec3(m.vel), n: vec3(m.n), hand: m.hand === 1 || m.hand === -1 ? m.hand : null, id: typeof m.id === 'number' ? m.id : null, pre: m.pre === true });
      }
      else if (m.t === 'tap') this.onTap?.(slot, m.what);
      else if (m.t === 'pong') {
        const t0 = s.pings.get(m.k);
        if (t0 !== undefined) {
          s.pings.delete(m.k);
          s.rtt.push(now - t0);
          if (s.rtt.length > 9) s.rtt.shift();
          if (typeof m.tp === 'number') {
            s.offs.push({ off: m.tp - (t0 + now) / 2, rtt: now - t0 });
            if (s.offs.length > 12) s.offs.shift();
          }
        }
      }
    });
    const drop = () => {
      if (slot >= 0 && this.slots[slot]?.conn === conn) {
        this.slots[slot] = null;
        this.onChange?.();
      }
    };
    conn.on('close', drop);
    conn.on('error', drop);
  }

  private pingAll() {
    const now = performance.now() / 1000;
    this.slots.forEach((s, i) => {
      if (!s || !s.conn.open) return;
      const k = ++this.pingK;
      s.pings.set(k, now);
      if (s.pings.size > 8) s.pings.delete(s.pings.keys().next().value!);
      this.send(i, { t: 'ping', k });
    });
  }
}

function clamp01(x: number) {
  return Math.max(0, Math.min(1, +x || 0));
}

/** a 3-vector from the wire, or null */
function vec3(v: unknown): number[] | null {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? v.map((x) => Math.max(-30, Math.min(30, x))) : null;
}

interface LanBridge { send(to: string, json: string): void; address(): string; advertise(code: string): void }
function lanBridge(): LanBridge | null {
  return ((window as unknown as { DinkLan?: LanBridge }).DinkLan) ?? null;
}

/** a phone on the Wi-Fi, shaped like a PeerJS DataConnection for Lobby.accept */
class LanConn {
  open = true;
  private handlers: Record<string, ((d?: unknown) => void)[]> = {};
  private seen = new Set<number>();
  private quiet = 0;
  constructor(readonly peer: string, private bridge: LanBridge, private onGone: () => void) {
    this.bump();
  }
  on(ev: string, fn: (d?: unknown) => void) {
    (this.handlers[ev] ??= []).push(fn);
  }
  send(m: unknown) {
    if (this.open) this.bridge.send(this.peer, JSON.stringify(m));
  }
  close() {
    if (!this.open) return;
    this.open = false;
    clearTimeout(this.quiet);
    this.onGone();
    for (const fn of this.handlers.close ?? []) fn();
  }
  receive(m: { sid?: number; t?: string }) {
    this.bump();
    if (typeof m.sid === 'number') {
      if (this.seen.has(m.sid)) return;
      this.seen.add(m.sid);
      if (this.seen.size > 64) this.seen.delete(this.seen.values().next().value as number);
    }
    if (m.t === 'bye') { this.close(); return; }
    for (const fn of this.handlers.data ?? []) fn(m);
  }
  private bump() {
    clearTimeout(this.quiet);
    this.quiet = window.setTimeout(() => this.close(), 8000);
  }
}
