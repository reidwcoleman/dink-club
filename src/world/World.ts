import * as THREE from 'three';
import { Sky, type SkyName } from './Sky.ts';
import { Court } from './Court.ts';
import { Net } from './Net.ts';
import { Club } from './Club.ts';
import { VENUES, type Venue } from './venues.ts';
import { Marks } from './Marks.ts';
import { Dust } from './Dust.ts';

/** everything static: sky, the courts, the net, the club around them (the crowd and players are added by the game) */
export class World {
  readonly scene = new THREE.Scene();
  readonly sky: Sky;
  court!: Court;
  net!: Net;
  club!: Club;
  readonly dust = new Dust();
  marks: Marks;
  venue: Venue;
  /** objects hidden while the environment map is captured (people, ball) */
  readonly dynamic: THREE.Object3D[] = [];

  constructor(readonly gl: THREE.WebGLRenderer, venueId = 'palms') {
    this.venue = VENUES[venueId] ?? VENUES.palms;
    this.sky = new Sky(this.scene, gl);
    this.marks = new Marks(gl);
  }

  async build(skyName?: SkyName) {
    await Promise.all([this.sky.load(), document.fonts.ready]);
    await Promise.all(['600 40px Inter', '800 40px Inter', '700 40px Inter', '300 40px Inter'].map((f) => document.fonts.load(f).catch(() => null)));
    this.court = new Court(this.venue, this.marks.texture);
    this.net = new Net('#16181b');
    this.club = new Club(this.venue);
    await Promise.all([this.court.load(), this.club.build(), this.sky.set(skyName ?? this.venue.sky)]);
    this.scene.add(this.court.mesh, this.net.group, this.club.group, this.dust.points);
    this.dust.color.set('#8a8a8a');
    this.dynamic.push(this.dust.points);
  }

  private applyLight() {
    const p = this.sky.preset;
    // aerial haze: the far palms, clubhouse and tree line sit back in the air (the sky dome and tree band carry their own)
    const haze = p.night ? '#0a0e18' : this.sky.name === 'sunset' ? '#e2b48f' : '#b9cde0';
    this.scene.fog = new THREE.FogExp2(new THREE.Color(haze).multiplyScalar(1 / Math.max(0.4, this.sky.exposure)), p.night ? 0.006 : 0.0085);
    this.club.setNight(p.night ? 1 : this.sky.name === 'sunset' ? 0.45 : 0, this.sky.exposure);
  }

  /** after everything is in the scene: capture the environment */
  finalize() {
    this.applyLight();
    this.sky.captureEnv(this.dynamic);
  }

  async setSky(name: SkyName) {
    await this.sky.set(name);
    this.applyLight();
    this.scene.environment = null;
    this.sky.captureEnv(this.dynamic);
  }

  /** the TV: bake the floor's full look under the current light (Court.bake) */
  bakeFloor() {
    this.court.bake(this.gl, this.scene, this.sky.sun, (c, hx, hz) => this.sky.placeSunShadow(c, hx, hz), this.dynamic, (on) => this.sky.bakeEnv(on, this.dynamic));
  }

  readonly ballPos = new THREE.Vector3(0, 1, 0);
  update(dt: number, _t: number) {
    this.net.update(dt);
    this.club.update(dt);
    this.dust.setLight((this.sky.horizontal / Math.PI) * 0.7);
    this.dust.update(dt);
  }
}
