import type { Match } from '../game/Match.ts';
import { SLOT_COLORS } from '../net/Link.ts';

/**
 * The TV graphics: a scorebug (top left), calls as a banner, the score call before each
 * serve, a prompt pill ("Swing to serve"), timing feedback when you hit (Early / Perfect /
 * Late), the phones' connection chips (top right) and the replay tag.
 */
export class HUD {
  readonly root: HTMLElement;
  private bug: HTMLElement;
  private banner: HTMLElement;
  private bannerSub: HTMLElement;
  private pill: HTMLElement;
  private calloutEl: HTMLElement;
  private timingEl: HTMLElement;
  private pads: HTMLElement;
  private tag: HTMLElement;
  private rallyEl: HTMLElement;
  private bannerTimer = 0;
  private calloutTimer = 0;
  private timingTimer = 0;
  names: [string, string] = ['You', 'CPU'];

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud');
    parent.appendChild(this.root);
    this.bug = el('div', 'bug');
    this.banner = el('div', 'banner');
    const bt = el('div', 'banner-title');
    this.bannerSub = el('div', 'banner-sub');
    this.banner.append(bt, this.bannerSub);
    this.pill = el('div', 'pill');
    this.calloutEl = el('div', 'callout');
    this.timingEl = el('div', 'timing');
    this.pads = el('div', 'pads');
    this.tag = el('div', 'rtag', '<span class="dot"></span>REPLAY');
    this.rallyEl = el('div', 'rally');
    this.root.append(this.bug, this.banner, this.pill, this.calloutEl, this.timingEl, this.pads, this.tag, this.rallyEl);
  }

  show(on: boolean) {
    this.root.style.display = on ? '' : 'none';
  }

  score(m: Match) {
    const rows = [0, 1].map((p) => {
      const games = m.cfg.games === 3 ? `<span class="gm">${m.games[p]}</span>` : '';
      const srv = m.server === p && m.winner === null;
      return `<div class="row ${srv ? 'serving' : ''}"><span class="sw" style="background:${SLOT_COLORS[p]}"></span><span class="nm">${esc(this.names[p])}</span>${games}<span class="srv">${srv ? ballIcon() : ''}</span><span class="pt">${m.score[p]}</span></div>`;
    });
    const tag = m.cfg.rally ? `RALLY TO ${m.cfg.to}` : `TO ${m.cfg.to}`;
    this.bug.innerHTML = `<div class="bug-tag">${tag}${m.cfg.games === 3 ? ' · BEST OF 3' : ''}</div>` + rows.join('');
  }

  call(title: string, sub = '', seconds = 2.2) {
    (this.banner.firstChild as HTMLElement).textContent = title;
    this.bannerSub.textContent = sub;
    this.banner.classList.remove('on');
    void this.banner.offsetWidth;
    this.banner.classList.add('on');
    this.bannerTimer = seconds;
  }

  /** the score call before the serve ("4-2") */
  callout(text: string) {
    this.calloutEl.textContent = text;
    this.calloutEl.classList.add('on');
    this.calloutTimer = 2.2;
  }

  prompt(text: string | null) {
    this.pill.innerHTML = text ? `${phoneIcon()}<span>${esc(text)}</span>` : '';
    this.pill.classList.toggle('on', !!text);
  }

  timing(text: string, slot: number) {
    this.timingEl.textContent = text;
    this.timingEl.className = 'timing on ' + text.toLowerCase().replace(/\s+/g, '-');
    this.timingEl.style.left = slot === 0 ? '50%' : '50%';
    this.timingTimer = 0.9;
  }

  /** the phones' chips */
  setPads(list: { label: string; name: string | null; color: string }[], code: string) {
    this.pads.innerHTML = list.map((p) => `<div class="padchip ${p.name ? 'live' : ''}"><span class="sw" style="background:${p.color}"></span>${p.label} ${p.name ? esc(p.name) : 'keyboard'}</div>`).join('') + (code ? `<div class="padchip code">Join: <b>${code}</b></div>` : '');
  }

  /** the running shot count in a long rally (0 hides it) */
  rally(n: number) {
    this.rallyEl.classList.toggle('on', n > 0);
    if (n > 0) {
      this.rallyEl.innerHTML = `<span>RALLY</span><b>${n}</b>`;
      this.rallyEl.classList.remove('pulse');
      void this.rallyEl.offsetWidth;
      this.rallyEl.classList.add('pulse');
    }
  }

  replayTag(on: boolean) {
    this.tag.classList.toggle('on', on);
  }

  update(dt: number) {
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) this.banner.classList.remove('on');
    }
    if (this.calloutTimer > 0) {
      this.calloutTimer -= dt;
      if (this.calloutTimer <= 0) this.calloutEl.classList.remove('on');
    }
    if (this.timingTimer > 0) {
      this.timingTimer -= dt;
      if (this.timingTimer <= 0) this.timingEl.classList.remove('on');
    }
  }
}

export function el(tag: string, cls: string, html = ''): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function ballIcon(): string {
  return `<svg viewBox="0 0 20 20" width="14" height="14"><circle cx="10" cy="10" r="8.5" fill="#e9f23a"/><g fill="#9aa51c"><circle cx="7" cy="7" r="1.3"/><circle cx="13" cy="7" r="1.3"/><circle cx="10" cy="10.5" r="1.3"/><circle cx="6.5" cy="13" r="1.3"/><circle cx="13.5" cy="13" r="1.3"/></g></svg>`;
}

export function phoneIcon(): string {
  return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/><path d="M2.5 9.5c-.8 1.5-.8 3.5 0 5M21.5 9.5c.8 1.5.8 3.5 0 5"/></svg>`;
}
