import type { Player, Plan, Skill } from './Player.ts';
import type { ShotType } from './Input.ts';
import { NVZ } from '../sim/dims.ts';

export type Difficulty = 'rookie' | 'club' | 'pro' | 'legend';

/** per level: movement + shot skills, how often it attacks, how often it drops vs drives, its error rate per shot */
export const AI_LEVELS: Record<Difficulty, { skill: Skill; aggression: number; drops: number; errors: number; name: string }> = {
  rookie: { skill: { speed: 3.9, accel: 11, power: 0.55, accuracy: 0.55, spin: 0.5, reaction: 0.3 }, aggression: 0.15, drops: 0.3, errors: 0.16, name: 'Rookie' },
  club: { skill: { speed: 4.4, accel: 13, power: 0.7, accuracy: 0.7, spin: 0.7, reaction: 0.22 }, aggression: 0.3, drops: 0.5, errors: 0.1, name: 'Club' },
  pro: { skill: { speed: 4.9, accel: 15, power: 0.85, accuracy: 0.84, spin: 0.85, reaction: 0.16 }, aggression: 0.45, drops: 0.65, errors: 0.065, name: 'Pro' },
  legend: { skill: { speed: 5.3, accel: 17, power: 0.95, accuracy: 0.93, spin: 0.95, reaction: 0.12 }, aggression: 0.55, drops: 0.75, errors: 0.04, name: 'Legend' },
};

export interface ShotChoice {
  type: ShotType;
  /** −1 … +1 across the opponent's court in the hitter's frame (+ = hitter's right) */
  aimX: number;
  power: number;
}

/**
 * The computer's shot for a planned contact, the way singles pickleball is played: serve deep,
 * return deep and come in, a third-shot drop (or a drive) from the baseline, dinks at the
 * kitchen until someone pops one up, then speed it up or put it away; lob a crowding net player.
 * `strike` is the number of this shot in the rally (2 = the return, 3 = the third shot).
 */
export function aiChooseShot(me: Player, plan: Plan, opp: Player, level: Difficulty, strike: number): ShotChoice {
  const L = AI_LEVELS[level];
  const R = Math.random;
  const myDepth = Math.abs(plan.body.z);
  const oppDepth = Math.abs(opp.pos.z);
  const atKitchen = myDepth < NVZ + 1.0;
  const oppAtNet = oppDepth < NVZ + 1.3;
  const h = plan.ball.y;
  // the opponent's position in my aim frame (+ = my right)
  const oppX = opp.pos.x * me.side;
  const away = oppX > 0.4 ? -1 : oppX < -0.4 ? 1 : R() < 0.5 ? -1 : 1;
  const cross = Math.sign(plan.body.x * me.side || (R() - 0.5));
  if (plan.smash) return { type: 'smash', aimX: away * (0.55 + L.skill.accuracy * 0.4), power: 0.75 + L.skill.power * 0.25 };
  if (strike === 2) return { type: 'reset', aimX: (R() - 0.5) * 1.2, power: 0.55 + R() * 0.2 };
  if (strike === 3 && !atKitchen) {
    if (R() < L.drops) return { type: 'drop', aimX: (R() - 0.5) * 1.2, power: 0.2 };
    return { type: 'drive', aimX: away * (0.3 + R() * 0.5), power: 0.7 + R() * 0.25 };
  }
  // a ball up above the net at the kitchen: speed it up at the body or into the gap
  if (atKitchen && h > 1.0 && R() < 0.35 + L.aggression) return { type: 'drive', aimX: R() < 0.4 ? Math.sign(oppX || 1) * 0.2 : away * (0.75 + L.skill.accuracy * 0.25), power: 0.75 + R() * 0.25 };
  if (atKitchen && oppAtNet) {
    if (R() < 0.05 + L.aggression * 0.08) return { type: 'lob', aimX: (R() - 0.5) * 1.2, power: 0.5 };
    return { type: 'dink', aimX: R() < 0.6 ? cross * (0.4 + R() * 0.5) : -cross * (0.2 + R() * 0.5), power: 0.15 };
  }
  if (atKitchen && !oppAtNet) {
    // the opponent stayed back: drop it short, or drive deep
    if (R() < 0.55) return { type: 'dink', aimX: away * (0.3 + R() * 0.5), power: 0.15 };
    return { type: 'drive', aimX: away * (0.5 + R() * 0.4), power: 0.6 + R() * 0.3 };
  }
  // I'm back: reset the ball into the kitchen if they're at the net, else work them deep
  if (oppAtNet) {
    if (R() < 0.12) return { type: 'lob', aimX: (R() - 0.5) * 1.2, power: 0.5 };
    return R() < L.drops ? { type: 'drop', aimX: (R() - 0.5) * 1.2, power: 0.2 } : { type: 'drive', aimX: away * (0.4 + R() * 0.5), power: 0.65 + R() * 0.3 };
  }
  return { type: R() < 0.3 ? 'drop' : 'reset', aimX: away * (0.2 + R() * 0.6), power: 0.45 + R() * 0.3 };
}

/** serve: deep, now and then to the body or wide */
export function aiServe(level: Difficulty): ShotChoice {
  const L = AI_LEVELS[level];
  const R = Math.random;
  return { type: 'serve', aimX: (R() - 0.5) * 1.6, power: 0.45 + L.skill.power * 0.35 * (0.6 + R() * 0.4) };
}
