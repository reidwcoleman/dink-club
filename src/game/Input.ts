/**
 * Swings. Every player's input is a stream of swings: a phone paddle (net/Link.ts sends one
 * at the peak of each real swing, with how hard and how much upward it was) or the keyboard
 * on the TV's computer. Movement is automatic — the player runs to the ball; you time the swing.
 *
 * Keyboard (player 1): Space = a swing (hold Shift for a hard one), Z = soft (dink / drop),
 * X = lob. Player 2 on the keyboard: Enter, with right Shift for hard.
 */
export type ShotType = 'dink' | 'drop' | 'reset' | 'drive' | 'lob' | 'smash' | 'serve';

export interface Swing {
  /** host clock (performance.now() / 1000) when the swing peaked */
  at: number;
  /** 0 a gentle push … 1 everything */
  power: number;
  /** −1 swung down … +1 swung up (a lob) */
  lift: number;
  /** a phone or the keys */
  from: 'phone' | 'keys';
  /** the screen's tilt to the sky at contact (−1 … +1), null without an orientation sensor */
  face?: number | null;
  /** where the face pointed relative to straight ahead (−1 left … +1 right, can exceed), null if unknown */
  aim?: number | null;
}

export class Input {
  private keys = new Set<string>();
  /** queued swings per player slot */
  private swings: Swing[][] = [[], []];
  anyKey = false;
  onPause: (() => void) | null = null;
  onCamera: (() => void) | null = null;

  constructor() {
    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.anyKey = true;
      this.keys.add(e.code);
      const now = performance.now() / 1000;
      const hard = this.keys.has('ShiftLeft');
      if (e.code === 'Space') { this.push(0, { at: now, power: hard ? 0.9 : 0.5, lift: 0, from: 'keys' }); e.preventDefault(); }
      if (e.code === 'KeyZ') this.push(0, { at: now, power: 0.12, lift: 0.2, from: 'keys' });
      if (e.code === 'KeyX') this.push(0, { at: now, power: 0.5, lift: 0.9, from: 'keys' });
      if (e.code === 'Enter') this.push(1, { at: now, power: this.keys.has('ShiftRight') ? 0.9 : 0.5, lift: 0, from: 'keys' });
      if (e.code === 'Escape' || e.code === 'KeyP') this.onPause?.();
      if (e.code === 'KeyC') this.onCamera?.();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }

  push(slot: number, s: Swing) {
    const q = this.swings[slot];
    if (!q) return;
    q.push(s);
    if (q.length > 4) q.shift();
  }

  /** the next swing for a slot (swings older than `maxAge` s are dropped) */
  take(slot: number, maxAge = 0.6): Swing | null {
    const q = this.swings[slot];
    const now = performance.now() / 1000;
    while (q.length && now - q[0].at > maxAge) q.shift();
    return q.shift() ?? null;
  }

  clear(slot?: number) {
    if (slot === undefined) this.swings.forEach((q) => (q.length = 0));
    else this.swings[slot].length = 0;
  }
}
