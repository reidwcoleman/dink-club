import type { Surface } from '../sim/dims.ts';

const SFX = import.meta.env.BASE_URL + 'sfx/';

/**
 * The club's sound: recorded paddle pops (soft / mid / hard, pitched a little per hit), the
 * ball's bounce, the crowd's cheers and "ooh"s, an outdoor ambience bed (other courts, palms,
 * birds) and the menu music, over the synthesized layers — sneaker squeaks, the net, a crowd
 * murmur that hushes during points, granular applause, and the line call through speech.
 */
export class Audio {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private crowdBus!: GainNode;
  private murmur!: GainNode;
  private applauseBuf: AudioBuffer | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private reverb!: ConvolverNode;
  private voice: SpeechSynthesisVoice | null = null;
  /** spoken calls (off: a club has no umpire — the players call it, and it shows on screen) */
  umpireOn = false;
  volume = 0.9;
  private samples = new Map<string, AudioBuffer>();
  private ambGain: GainNode | null = null;
  private musicGain: GainNode | null = null;

  /** create on the first user gesture */
  start() {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 3;
    this.master.connect(comp).connect(ctx.destination);
    // outdoors: no hall tail, just slaps off the clubhouse, the fences and the bleachers
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.outdoorImpulse();
    const wet = ctx.createGain();
    wet.gain.value = 0.3;
    this.reverb.connect(wet).connect(this.master);
    this.sfx = ctx.createGain();
    this.sfx.gain.value = 0.9;
    this.sfx.connect(this.master);
    this.sfx.connect(this.reverb);
    this.crowdBus = ctx.createGain();
    this.crowdBus.gain.value = 0.8;
    this.crowdBus.connect(this.master);
    this.crowdBus.connect(this.reverb);
    this.noiseBuf = this.makeNoise(3);
    this.applauseBuf = this.makeApplause(9);
    this.startMurmur();
    this.pickVoice();
    void this.loadSamples();
  }

  private async loadSamples() {
    const ctx = this.ctx!;
    const names = ['pop1', 'pop2', 'pop3', 'bounce', 'cheer', 'ooh', 'ambience', 'music'];
    await Promise.all(names.map(async (n) => {
      try {
        const buf = await (await fetch(SFX + n + '.mp3')).arrayBuffer();
        this.samples.set(n, await ctx.decodeAudioData(buf));
      } catch { /* missing: the synth layers cover it */ }
    }));
    const loop = (name: string, gain: number) => {
      const b = this.samples.get(name);
      if (!b) return null;
      const src = ctx.createBufferSource();
      src.buffer = b;
      src.loop = true;
      const g = ctx.createGain();
      g.gain.value = gain;
      src.connect(g).connect(this.master);
      src.start();
      return g;
    };
    this.ambGain = loop('ambience', 0.32);
    this.musicGain = loop('music', this.musicLevel);
  }

  private musicLevel = 0.45;
  /** menu music up, in-game down (0 … 1) */
  music(level: number, time = 1.5) {
    this.musicLevel = level * 0.45;
    if (!this.ctx || !this.musicGain) return;
    this.musicGain.gain.cancelScheduledValues(this.ctx.currentTime);
    this.musicGain.gain.setTargetAtTime(this.musicLevel, this.ctx.currentTime, time / 3);
  }

  /** play a sample (rate varies the pitch) */
  private play(name: string, gain: number, rate = 1, pan = 0, bus?: GainNode): boolean {
    const b = this.samples.get(name);
    if (!this.ctx || !b) return false;
    const src = this.ctx.createBufferSource();
    src.buffer = b;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    const p = this.ctx.createStereoPanner();
    p.pan.value = pan;
    src.connect(g).connect(p).connect(bus ?? this.sfx);
    src.start();
    return true;
  }

  /**
   * The paddle: that hollow pickleball "pock" — brighter and sharper the harder it's hit; an
   * off-centre hit (low quality) is a duller, lower "clack" off the edge of the face.
   */
  pop(power: number, kind: 'soft' | 'mid' | 'hard', pan = 0, dist = 10, quality = 1) {
    if (!this.ctx) return;
    const near = Math.max(0.3, Math.min(1.3, 12 / (dist + 3)));
    const name = kind === 'soft' ? 'pop3' : kind === 'hard' ? 'pop2' : 'pop1';
    const b = this.samples.get(name);
    if (!b) { this.hit(power, kind === 'soft' ? 'slice' : 'drive', pan, dist); return; }
    const { t, out } = this.place(dist, pan);
    const src = this.ctx.createBufferSource();
    src.buffer = b;
    const mishit = quality < 0.6;
    src.playbackRate.value = (mishit ? 0.8 : 0.93 + power * 0.1) * (0.97 + Math.random() * 0.06);
    const g = this.ctx.createGain();
    g.gain.value = (0.5 + power * 0.7) * near * (mishit ? 0.75 : 1);
    let node: AudioNode = src;
    if (mishit) {
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 1800;
      node = src.connect(f);
      // the rim: a short click
      this.noise(t, 0.02, 'bandpass', 3400, 3, 0.18 * near, 0.0005, pan);
    }
    node.connect(g).connect(out);
    src.start(t);
  }

  /** a shoe on acrylic: a soft scuff each step, a short chirp on hard stops */
  step(strength: number, pan = 0, dist = 10) {
    if (!this.ctx || !this.noiseBuf) return;
    const k = Math.max(0.15, Math.min(1, 9 / (dist + 2))) * strength;
    const { t, out } = this.place(dist, pan);
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900 + Math.random() * 700;
    bp.Q.value = 0.9;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.11 * k, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    src.connect(bp).connect(g).connect(out);
    src.start(t, Math.random() * 2, 0.1);
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  private impulse(seconds: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const n = Math.floor(ctx.sampleRate * seconds);
    const b = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay) * (i < 400 ? i / 400 : 1);
    }
    return b;
  }

  /** a few discrete early reflections (8-90 ms) over a short diffuse 0.5 s decay */
  private outdoorImpulse(): AudioBuffer {
    const ctx = this.ctx!;
    const sr = ctx.sampleRate, n = Math.floor(sr * 0.7);
    const b = ctx.createBuffer(2, n, sr);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (const [ms, g] of [[9, 0.5], [23, 0.32], [41, 0.26], [58, 0.18], [87, 0.12]] as const) {
        const i = Math.floor(((ms + (c ? 3 : 0) + Math.random() * 2) / 1000) * sr);
        for (let k = 0; k < 40; k++) d[i + k] += (Math.random() * 2 - 1) * g * Math.exp(-k / 9);
      }
      for (let i = 0; i < n; i++) d[i] += (Math.random() * 2 - 1) * 0.05 * Math.pow(1 - i / n, 4) * (i > sr * 0.02 ? 1 : 0);
    }
    return b;
  }

  /**
   * where a sound comes from: sound takes ~38 ms to cross the court and the air takes the
   * top off with distance, so the far player's hits arrive later and duller
   */
  private place(dist: number, pan: number): { t: number; out: AudioNode } {
    const ctx = this.ctx!;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.max(2600, 16000 - dist * 520);
    lp.Q.value = 0.5;
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    lp.connect(p).connect(this.sfx);
    return { t: ctx.currentTime + Math.min(0.08, dist / 343), out: lp };
  }

  private makeNoise(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const n = Math.floor(ctx.sampleRate * seconds);
    const b = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  /** thousands of claps: each a 6-25 ms burst of filtered noise, stereo-scattered */
  private makeApplause(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const sr = ctx.sampleRate;
    const n = Math.floor(sr * seconds);
    const b = ctx.createBuffer(2, n, sr);
    const L = b.getChannelData(0), R = b.getChannelData(1);
    const claps = Math.floor(seconds * 1400);
    for (let k = 0; k < claps; k++) {
      const start = Math.floor(Math.random() * n);
      const len = Math.floor(sr * (0.006 + Math.random() * 0.02));
      const amp = 0.05 + Math.random() * 0.12;
      const pan = Math.random();
      // a crude resonant burst: noise through a one-pole band emphasis at 1-3 kHz
      const f = (1000 + Math.random() * 2200) / sr;
      let y1 = 0, y2 = 0;
      const r = 0.93;
      const c1 = 2 * r * Math.cos(2 * Math.PI * f), c2 = -r * r;
      for (let i = 0; i < len; i++) {
        const idx = (start + i) % n;
        const x = (Math.random() * 2 - 1) * Math.exp(-i / (len * 0.28));
        const y = x + c1 * y1 + c2 * y2;
        y2 = y1;
        y1 = y;
        const v = y * amp * 0.35;
        L[idx] += v * (1 - pan);
        R[idx] += v * pan;
      }
    }
    // soft-limit
    for (const d of [L, R]) for (let i = 0; i < n; i++) d[i] = Math.tanh(d[i] * 1.2) * 0.8;
    return b;
  }

  private startMurmur() {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 520;
    bp.Q.value = 0.6;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400;
    this.murmur = ctx.createGain();
    this.murmur.gain.value = 0.05;
    // slow swells
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.13;
    const lg = ctx.createGain();
    lg.gain.value = 0.015;
    lfo.connect(lg).connect(this.murmur.gain);
    lfo.start();
    src.connect(bp).connect(lp).connect(this.murmur).connect(this.crowdBus);
    src.start();
  }

  /** crowd level: 0 hushed (point in play) … 1 chatter */
  crowdLevel(level: number, time = 1.2) {
    if (!this.ctx) return;
    const g = this.murmur.gain;
    g.cancelScheduledValues(this.ctx.currentTime);
    g.setTargetAtTime(0.004 + level * 0.022, this.ctx.currentTime, time / 3);
  }

  private env(g: GainNode, t: number, a: number, peak: number, d: number) {
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }

  private noise(t: number, dur: number, type: BiquadFilterType, freq: number, q: number, peak: number, attack = 0.001, pan = 0) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    this.env(g, t, attack, peak, dur);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    src.connect(f).connect(g).connect(p).connect(this.sfx);
    src.start(t, Math.random() * 2, attack + dur + 0.05);
  }

  private tone(t: number, freq: number, dur: number, peak: number, type: OscillatorType = 'sine', glide = 1, pan = 0) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (glide !== 1) o.frequency.exponentialRampToValueAtTime(freq * glide, t + dur);
    const g = ctx.createGain();
    this.env(g, t, 0.0015, peak, dur);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    o.connect(g).connect(p).connect(this.sfx);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** racket strike: power 0..1, slice softer */
  hit(power: number, kind: 'drive' | 'slice' | 'serve' | 'volley' | 'frame', pan = 0, dist = 10) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const near = Math.max(0.25, Math.min(1.2, 14 / (dist + 4)));
    const p = Math.max(0.15, power);
    if (kind === 'frame') {
      this.noise(t, 0.05, 'bandpass', 900, 2, 0.35 * near, 0.001, pan);
      this.tone(t, 330, 0.06, 0.2 * near, 'triangle', 0.8, pan);
      return;
    }
    const soft = kind === 'slice' || kind === 'volley' ? 0.65 : 1;
    // string-bed "pop"
    this.tone(t, 520 + p * 260, 0.045 + p * 0.02, 0.55 * p * near * soft, 'sine', 0.72, pan);
    this.tone(t, 1150 + p * 400, 0.02, 0.25 * p * near * soft, 'triangle', 0.8, pan);
    // felt/impact click
    this.noise(t, 0.028 + p * 0.02, 'bandpass', 2300 + p * 800, 1.2, 0.7 * p * near * soft, 0.0008, pan);
    // body
    this.noise(t, 0.06, 'lowpass', 380, 0.7, 0.4 * p * near, 0.001, pan);
  }

  bounce(surface: Surface, speed: number, pan = 0, dist = 15) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const k = Math.min(1, speed / 25) * Math.max(0.2, Math.min(1, 16 / (dist + 3)));
    if (surface === 'hard' && this.samples.get('bounce')) {
      const { t: t0, out } = this.place(dist, pan);
      const src = this.ctx.createBufferSource();
      src.buffer = this.samples.get('bounce')!;
      src.playbackRate.value = 0.93 + Math.min(1, speed / 25) * 0.12 + Math.random() * 0.04;
      const g = this.ctx.createGain();
      g.gain.value = 0.9 * k + 0.08;
      src.connect(g).connect(out);
      src.start(t0);
      return;
    }
    if (surface === 'hard') {
      this.tone(t, 480, 0.05, 0.35 * k, 'sine', 0.7, pan);
      this.noise(t, 0.035, 'bandpass', 1600, 1.4, 0.35 * k, 0.001, pan);
    } else if (surface === 'clay') {
      this.tone(t, 260, 0.06, 0.28 * k, 'sine', 0.6, pan);
      this.noise(t, 0.09, 'bandpass', 3000, 0.7, 0.18 * k, 0.003, pan); // grit
    } else {
      this.tone(t, 220, 0.05, 0.25 * k, 'sine', 0.6, pan);
      this.noise(t, 0.05, 'lowpass', 700, 0.7, 0.2 * k, 0.002, pan);
    }
  }

  net(power: number) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.noise(t, 0.18, 'lowpass', 500, 0.8, 0.45 * Math.min(1, power / 20), 0.005);
    this.noise(t + 0.02, 0.25, 'bandpass', 2200, 3, 0.08, 0.01); // cord rattle
  }

  squeak(pan = 0, strength = 1) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const f = 2400 + Math.random() * 1400;
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f, t);
    o.frequency.linearRampToValueAtTime(f * (1.08 + Math.random() * 0.1), t + 0.08);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = f;
    bp.Q.value = 9;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.045 * strength, t + 0.012);
    g.gain.setValueAtTime(0.045 * strength, t + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    const p = this.ctx.createStereoPanner();
    p.pan.value = pan;
    o.connect(bp).connect(g).connect(p).connect(this.sfx);
    o.start(t);
    o.stop(t + 0.12);
  }

  /** applause: intensity 0..1, duration seconds */
  applause(intensity: number, duration = 3.5) {
    if (!this.ctx || !this.applauseBuf) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.applauseBuf;
    src.loop = true;
    src.playbackRate.value = 0.92 + Math.random() * 0.16;
    const g = ctx.createGain();
    const peak = 0.25 + intensity * 0.75;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.35);
    g.gain.setValueAtTime(peak, t + duration * 0.45);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    src.connect(g).connect(this.crowdBus);
    src.start(t, Math.random() * 6);
    src.stop(t + duration + 0.1);
    if (intensity > 0.55) this.play('cheer', 0.35 + intensity * 0.6, 0.96 + Math.random() * 0.08, 0, this.crowdBus);
    else if (intensity > 0.85) this.roar(intensity, duration * 0.8);
  }

  /** a cheering swell (vowel-ish formants over noise) */
  roar(intensity: number, duration = 2.5) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    for (const [f, q, a] of [[450, 2, 0.5], [1100, 3, 0.35], [2500, 4, 0.15]] as const) {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f;
      bp.Q.value = q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(a * intensity * 0.5, t + 0.4);
      g.gain.exponentialRampToValueAtTime(0.001, t + duration);
      src.connect(bp).connect(g).connect(this.crowdBus);
      src.start(t, Math.random());
      src.stop(t + duration + 0.1);
    }
  }

  /** the crowd's "ooh" (close call, net cord, a great get) */
  ooh(intensity = 0.7) {
    if (!this.ctx) return;
    if (this.play('ooh', 0.4 + intensity * 0.5, 0.95 + Math.random() * 0.1, 0, this.crowdBus)) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    for (const [f, a] of [[320, 0.6], [800, 0.3]] as const) {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 5;
      bp.frequency.setValueAtTime(f * 0.85, t);
      bp.frequency.linearRampToValueAtTime(f * 1.1, t + 0.5);
      bp.frequency.linearRampToValueAtTime(f * 0.9, t + 1.3);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(a * intensity * 0.6, t + 0.25);
      g.gain.exponentialRampToValueAtTime(0.001, t + 1.5);
      src.connect(bp).connect(g).connect(this.crowdBus);
      src.start(t, Math.random());
      src.stop(t + 1.6);
    }
  }

  private pickVoice() {
    const pick = () => {
      const vs = speechSynthesis.getVoices();
      this.voice = vs.find((v) => /Daniel|Arthur|Oliver|en-GB/i.test(v.name + v.lang) && /en/i.test(v.lang)) ?? vs.find((v) => /en/i.test(v.lang)) ?? null;
    };
    try {
      pick();
      speechSynthesis.onvoiceschanged = pick;
    } catch { /* no speech */ }
  }

  /** the chair umpire */
  say(text: string) {
    if (!this.umpireOn) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      if (this.voice) u.voice = this.voice;
      u.rate = 0.92;
      u.pitch = 0.92;
      u.volume = 0.85 * this.volume;
      speechSynthesis.speak(u);
    } catch { /* ignore */ }
  }
}
