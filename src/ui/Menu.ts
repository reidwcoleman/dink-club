import qrcode from 'qrcode-generator';
import { el, esc } from './HUD.ts';
import { SLOT_COLORS } from '../net/Link.ts';
import type { Match } from '../game/Match.ts';

export interface MenuChoice {
  level: string;
  format: string;
  sky: string;
  players: string;
}

const OPTIONS: Record<keyof MenuChoice, { label: string; items: [string, string][] }> = {
  players: { label: 'Players', items: [['1', 'You vs CPU'], ['2', 'Head to head']] },
  level: { label: 'Opponent', items: [['rookie', 'Rookie'], ['club', 'Club'], ['pro', 'Pro'], ['legend', 'Legend']] },
  format: { label: 'Game', items: [['classic11', 'Classic to 11'], ['rally15', 'Rally to 15'], ['quick7', 'Quick to 7'], ['bo3', 'Best of 3']] },
  sky: { label: 'Time', items: [['sunset', 'Golden hour'], ['day', 'Midday'], ['night', 'Under lights']] },
};

/**
 * The start screen over the club flyover: the logo, the join card (a QR code + room code
 * for phones), who's connected, and the game settings. Phones can start the game too.
 */
export class Menu {
  readonly root: HTMLElement;
  private status: HTMLElement;
  private qr: HTMLElement;
  private code: HTMLElement;
  private url: HTMLElement;
  private slotsEl: HTMLElement;
  private playBtn: HTMLButtonElement;
  onPlay: ((c: MenuChoice) => void) | null = null;
  onChange: ((key: keyof MenuChoice, c: MenuChoice) => void) | null = null;

  constructor(parent: HTMLElement, readonly choice: MenuChoice) {
    this.root = el('div', 'menu');
    parent.appendChild(this.root);
    const left = el('div', 'm-left');
    const logo = el('img', 'm-logo') as HTMLImageElement;
    logo.src = import.meta.env.BASE_URL + 'art/logo.webp';
    logo.alt = 'Dink Club';
    const tag = el('div', 'm-tag', 'Your phone is the paddle.');
    const how = el('div', 'm-how', `<div><b>1</b> Scan the code with your phone</div><div><b>2</b> Hold it like a paddle</div><div><b>3</b> Swing when the ball arrives — early pulls it, late pushes it, soft swings dink, swing up to lob</div>`);
    left.append(logo, tag, how);

    const card = el('div', 'm-card');
    const join = el('div', 'm-join');
    this.qr = el('div', 'm-qr');
    const jt = el('div', 'm-jt');
    jt.append(el('div', 'm-jl', 'Grab a paddle'), (this.code = el('div', 'm-code', '····')), (this.url = el('div', 'm-url', 'Opening the club…')));
    join.append(this.qr, jt);
    this.slotsEl = el('div', 'm-slots');
    const opts = el('div', 'm-opts');
    for (const key of Object.keys(OPTIONS) as (keyof MenuChoice)[]) {
      const o = OPTIONS[key];
      const row = el('div', 'm-row');
      row.append(el('div', 'm-rl', o.label));
      const seg = el('div', 'seg');
      for (const [val, label] of o.items) {
        const b = el('button', 'segb' + (choice[key] === val ? ' on' : ''), esc(label)) as HTMLButtonElement;
        b.onclick = () => {
          choice[key] = val;
          seg.querySelectorAll('.segb').forEach((x) => x.classList.remove('on'));
          b.classList.add('on');
          this.onChange?.(key, choice);
        };
        seg.append(b);
      }
      row.append(seg);
      opts.append(row);
    }
    this.playBtn = el('button', 'm-play', 'Play') as HTMLButtonElement;
    this.playBtn.onclick = () => this.onPlay?.(this.choice);
    this.status = el('div', 'm-status');
    const keys = el('div', 'm-keys', 'No phone? <b>Space</b> swing · <b>Shift+Space</b> hard · <b>Z</b> dink · <b>X</b> lob');
    const snd = el('div', 'm-sound', 'Click anywhere on this screen to turn the sound on');
    card.append(join, this.slotsEl, opts, this.playBtn, this.status, keys, snd);
    this.root.append(left, card);
    this.setSlots([null, null]);
  }

  setJoin(code: string, url: string) {
    const q = qrcode(0, 'M');
    q.addData(url);
    q.make();
    this.qr.innerHTML = q.createSvgTag({ cellSize: 6, margin: 0, scalable: true });
    this.code.textContent = code;
    this.url.textContent = url.replace(/^https?:\/\//, '');
  }

  setOffline() {
    this.code.textContent = '—';
    this.url.textContent = 'Phones can’t connect right now (offline). Keyboard works.';
  }

  setSlots(names: (string | null)[]) {
    this.slotsEl.innerHTML = names.map((n, i) => `<div class="m-slot ${n ? 'live' : ''}"><span class="sw" style="background:${SLOT_COLORS[i]}"></span><span class="lbl">P${i + 1}</span><span class="nm">${n ? esc(n) : i === 0 ? 'Waiting for a phone…' : 'Optional second phone'}</span>${n ? '<span class="ok">Connected</span>' : ''}</div>`).join('');
  }

  setStatus(s: string) {
    this.status.textContent = s;
  }

  busy(on: boolean) {
    this.playBtn.disabled = on;
    this.root.classList.toggle('busy', on);
  }

  hide() {
    this.root.classList.add('gone');
  }

  show() {
    this.root.classList.remove('gone');
  }
}

export function pauseOverlay(parent: HTMLElement, onResume: () => void, onQuit: () => void): HTMLElement {
  const o = el('div', 'overlay');
  const card = el('div', 'ocard');
  card.append(el('h2', '', 'Paused'));
  const r = el('button', 'm-play', 'Resume') as HTMLButtonElement;
  r.onclick = onResume;
  const q = el('button', 'm-ghost', 'Back to menu') as HTMLButtonElement;
  q.onclick = onQuit;
  card.append(r, q);
  o.append(card);
  parent.append(o);
  return o;
}

export function summaryOverlay(parent: HTMLElement, m: Match, names: [string, string], onAgain: () => void, onMenu: () => void): HTMLElement {
  const o = el('div', 'overlay');
  const card = el('div', 'ocard sum');
  const w = m.winner ?? 0;
  card.append(el('div', 'sum-k', 'Game, match'), el('h2', '', `${esc(names[w])} wins`));
  const games = m.history.map((g) => `<span>${g[0]}–${g[1]}</span>`).join('');
  card.append(el('div', 'sum-games', games));
  const st = m.stats;
  const rows: [string, number, number][] = [
    ['Points won', st[0].points, st[1].points],
    ['Winners', st[0].winners, st[1].winners],
    ['Errors', st[0].errors, st[1].errors],
    ['Aces', st[0].aces, st[1].aces],
    ['Longest rally', st[0].longestRally, st[1].longestRally],
  ];
  card.append(el('div', 'sum-table', `<div class="sh"><span></span><span>${esc(names[0])}</span><span>${esc(names[1])}</span></div>` + rows.map((r) => `<div><span>${r[0]}</span><b>${r[1]}</b><b>${r[2]}</b></div>`).join('')));
  const a = el('button', 'm-play', 'Rematch') as HTMLButtonElement;
  a.onclick = onAgain;
  const b = el('button', 'm-ghost', 'Menu') as HTMLButtonElement;
  b.onclick = onMenu;
  card.append(a, b, el('div', 'm-keys', 'Or swing / tap Rematch on your phone'));
  o.append(card);
  parent.append(o);
  return o;
}
