import type { Surface } from '../sim/dims.ts';
import type { SkyName } from './Sky.ts';

/** a club's identity: court paint, fences, one accent */
export interface Venue {
  id: string;
  name: string;
  short: string;
  city: string;
  surface: Surface;
  courtIn: string;
  kitchen: string;
  courtOut: string;
  line: string;
  dirt: string;
  /** windscreen fabric */
  screen: string;
  /** fence posts / rails */
  steel: string;
  accent: string;
  sky: SkyName;
}

export const VENUES: Record<string, Venue> = {
  palms: {
    id: 'palms', name: 'Dink Club Palms', short: 'The Palms', city: 'Palm Coast', surface: 'hard',
    courtIn: '#2e5f9e', kitchen: '#3f86b8', courtOut: '#3c7350', line: '#f4f4ef', dirt: '#6a5a48',
    screen: '#173b2a', steel: '#2a2d30', accent: '#ff8a1f',
    sky: 'sunset',
  },
};
