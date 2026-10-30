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
  | { t: 'swing'; power: number; lift: number; peak: number; ago?: number }
  | { t: 'tap'; what: 'start' | 'pause' | 'again' }
  | { t: 'pong'; k: number };

/** TV → phone */
export type TvMsg =
  | { t: 'welcome'; slot: number; color: string; label: string }
  | { t: 'state'; text: string; sub?: string; serve?: boolean; score?: string }
  | { t: 'hit'; power: number; quality: number; shot: string }
  | { t: 'whiff' }
  | { t: 'point'; won: boolean; call: string }
  | { t: 'ping'; k: number }
  | { t: 'full' };

export const SLOT_COLORS = ['#ff8a1f', '#2fc4c0'];

interface Slot {
  conn: DataConnection;
  id: string;
  name: string;
  paddle: number;
  rtt: number[];
  pings: Map<number, number>;
}

export class Lobby {
  code = '';
  peer: Peer | null = null;
  readonly slots: (Slot | null)[] = [null, null];
  status: 'connecting' | 'ready' | 'offline' = 'connecting';
  onSwing: ((slot: number, power: number, lift: number, at: number) => void) | null = null;
  onTap: ((slot: number, what: string) => void) | null = null;
  onChange: (() => void) | null = null;
  private pingK = 0;

  async open(): Promise<void> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = Array.from({ length: 4 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join('');
      const ok = await this.tryOpen(code);
      if (ok) {
        this.code = code;
        this.status = 'ready';
        this.onChange?.();
        setInterval(() => this.pingAll(), 1500);
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
    u.search = `?room=${this.code}`;
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
        this.slots[slot] = { conn, id: m.id, name: (m.name || `Player ${slot + 1}`).slice(0, 14), paddle: m.paddle | 0, rtt: old?.rtt ?? [], pings: new Map() };
        conn.send({ t: 'welcome', slot, color: SLOT_COLORS[slot], label: `P${slot + 1}` } satisfies TvMsg);
        this.onChange?.();
        return;
      }
      if (slot < 0 || this.slots[slot]?.conn !== conn) return;
      const s = this.slots[slot]!;
      if (m.t === 'swing') this.onSwing?.(slot, clamp01(m.power), Math.max(-1, Math.min(1, m.lift)), now - this.delay(slot) - Math.min(0.12, Math.max(0, +(m.ago ?? 0))));
      else if (m.t === 'tap') this.onTap?.(slot, m.what);
      else if (m.t === 'pong') {
        const t0 = s.pings.get(m.k);
        if (t0 !== undefined) {
          s.pings.delete(m.k);
          s.rtt.push(now - t0);
          if (s.rtt.length > 9) s.rtt.shift();
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
