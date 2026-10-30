/**
 * Pickleball court dimensions (metres, USA Pickleball rulebook). Frame: x across the court
 * (right of the near baseline is +x), z along it (net at z = 0, the near baseline at z = +HL), y up.
 * The court is 20 × 44 ft; lines are 2 in wide and part of the area they bound (the kitchen
 * line belongs to the kitchen).
 */
export const HL = 6.706; // half length (outer edge of the baseline)
export const HW = 3.048; // half width (outer edge of the sideline)
/** the non-volley zone ("the kitchen"): 7 ft from the net */
export const NVZ = 2.134;
export const LINE = 0.0508;
export const NET_CENTER = 0.864;
export const NET_POST = 0.914;
/** the posts stand 12 in outside the sidelines */
export const POST_X = HW + 0.3048;
/** the fenced playing area around the court (30 × 60 ft is the recommended minimum; this club is roomier) */
export const FLOOR_HX = 5.6;
export const FLOOR_HZ = 10.4;

/** an outdoor ball: 74 mm, 26 g, 40 round holes */
export const BALL_R = 0.037;
export const BALL_M = 0.026;

/** the net's top height at x: 34 in at the centre strap, 36 in at the posts */
export function netTop(x: number): number {
  const a = Math.min(1, Math.abs(x) / POST_X);
  return NET_CENTER + (NET_POST - NET_CENTER) * (a * a * 0.4 + a * 0.6);
}

export type Surface = 'hard' | 'clay' | 'grass';

/** ball–surface interaction (see Ball.ts): a plastic ball on acrylic is lively off the floor but bites */
export const SURFACE_PHYS: Record<Surface, { e: number; mu: number; keep: number; name: string }> = {
  hard: { e: 0.68, mu: 0.42, keep: 1.0, name: 'Acrylic' },
  clay: { e: 0.66, mu: 0.6, keep: 0.94, name: 'Clay' },
  grass: { e: 0.6, mu: 0.36, keep: 1.0, name: 'Grass' },
};

/** is (x, z) inside the kitchen on either side (the line counts) */
export function inKitchen(z: number): boolean {
  return Math.abs(z) <= NVZ;
}
