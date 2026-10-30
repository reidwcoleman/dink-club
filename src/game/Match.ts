/**
 * Pickleball singles scoring. Classic side-out scoring: only the server scores; the server
 * serves from the right court on an even score and the left on an odd one; losing the rally
 * passes the serve. Rally scoring (an option): every rally scores and the rally's winner serves.
 * Games to 11 (or 15 / 21), win by two; a match is one game or the best of three.
 */
export type PointReason = 'winner' | 'out' | 'net' | 'fault' | 'kitchen' | 'double-bounce' | 'volley-return' | 'ace';

export interface MatchConfig {
  to: number;
  games: 1 | 3;
  rally: boolean;
}

export interface Stats {
  points: number;
  winners: number;
  errors: number;
  aces: number;
  longestRally: number;
}

export class Match {
  readonly score: [number, number] = [0, 0];
  readonly games: [number, number] = [0, 0];
  readonly history: [number, number][] = [];
  server: 0 | 1;
  private gameFirstServer: 0 | 1;
  winner: 0 | 1 | null = null;
  readonly stats: [Stats, Stats] = [newStats(), newStats()];

  constructor(readonly cfg: MatchConfig, firstServer: 0 | 1) {
    this.server = firstServer;
    this.gameFirstServer = firstServer;
  }

  /** the server serves from the right court when their score is even */
  get fromRight(): boolean {
    return this.score[this.server] % 2 === 0;
  }

  /** the call before a serve: server's score first */
  call(): string {
    const s = this.server;
    return `${this.score[s]}-${this.score[1 - s]}`;
  }

  /** a rally ended; returns what it meant */
  rallyTo(w: 0 | 1, reason: PointReason, rallyLen: number): { scored: boolean; sideOut: boolean; game: boolean; match: boolean } {
    const st = this.stats;
    st[w].longestRally = Math.max(st[w].longestRally, rallyLen);
    st[1 - w].longestRally = Math.max(st[1 - w].longestRally, rallyLen);
    if (reason === 'winner') st[w].winners++;
    if (reason === 'ace') st[w].aces++;
    if (reason === 'out' || reason === 'net' || reason === 'fault' || reason === 'kitchen' || reason === 'volley-return') st[1 - w].errors++;
    let scored = false, sideOut = false;
    if (this.cfg.rally) {
      this.score[w]++;
      scored = true;
      if (this.server !== w) sideOut = true;
      this.server = w;
    } else if (w === this.server) {
      this.score[w]++;
      scored = true;
    } else {
      this.server = w;
      sideOut = true;
    }
    if (scored) st[w].points++;
    const a = this.score[0], b = this.score[1];
    const to = this.cfg.to;
    let game = false, match = false;
    if ((a >= to || b >= to) && Math.abs(a - b) >= 2) {
      game = true;
      const gw: 0 | 1 = a > b ? 0 : 1;
      this.games[gw]++;
      this.history.push([a, b]);
      const need = this.cfg.games === 1 ? 1 : 2;
      if (this.games[gw] >= need) {
        match = true;
        this.winner = gw;
      } else {
        this.score[0] = this.score[1] = 0;
        // the other player starts the next game
        this.gameFirstServer = (1 - this.gameFirstServer) as 0 | 1;
        this.server = this.gameFirstServer;
      }
    }
    return { scored, sideOut, game, match };
  }

  /** game point / match point for someone (when they are serving, or under rally scoring) */
  pressure(): { gamePoint: 0 | 1 | null; matchPoint: boolean } {
    const to = this.cfg.to;
    for (const p of [0, 1] as const) {
      const canScore = this.cfg.rally || this.server === p;
      if (!canScore) continue;
      const me = this.score[p], them = this.score[1 - p];
      if (me + 1 >= to && me + 1 - them >= 2) {
        const need = this.cfg.games === 1 ? 1 : 2;
        return { gamePoint: p, matchPoint: this.games[p] + 1 >= need };
      }
    }
    return { gamePoint: null, matchPoint: false };
  }
}

function newStats(): Stats {
  return { points: 0, winners: 0, errors: 0, aces: 0, longestRally: 0 };
}
