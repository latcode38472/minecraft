// Day/night cycle: time of day drives sun direction, light intensities, and a
// sky/fog colour interpolated between keyframed palettes.
// t=0 midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset.

import * as THREE from 'three';
import { DAY_LENGTH_SECONDS, START_TIME_OF_DAY } from './constants';

interface SkyKeyframe {
  t: number;
  sky: THREE.Color;
}

const KEYFRAMES: SkyKeyframe[] = [
  { t: 0.0, sky: new THREE.Color(0x0b1026) },
  { t: 0.2, sky: new THREE.Color(0x0b1026) },
  { t: 0.27, sky: new THREE.Color(0xdf8a4e) },
  { t: 0.35, sky: new THREE.Color(0x87ceeb) },
  { t: 0.65, sky: new THREE.Color(0x87ceeb) },
  { t: 0.73, sky: new THREE.Color(0xe0703a) },
  { t: 0.8, sky: new THREE.Color(0x0b1026) },
  { t: 1.0, sky: new THREE.Color(0x0b1026) },
];

export class Sky {
  timeOfDay = START_TIME_OF_DAY;
  readonly skyColor = new THREE.Color();

  private readonly sun: THREE.DirectionalLight;
  private readonly hemi: THREE.HemisphereLight;

  constructor(private readonly scene: THREE.Scene) {
    this.sun = new THREE.DirectionalLight(0xffffff, 1.2);
    this.hemi = new THREE.HemisphereLight(0xbfd8ff, 0x8a7a5a, 0.7);
    scene.add(this.sun);
    scene.add(this.sun.target);
    scene.add(this.hemi);
  }

  update(dt: number): void {
    this.timeOfDay = (this.timeOfDay + dt / DAY_LENGTH_SECONDS) % 1;
    const t = this.timeOfDay;

    // Sun sweeps an east-west arc; elevation is sin of the day angle.
    const angle = (t - 0.25) * Math.PI * 2;
    const elevation = Math.sin(angle);
    this.sun.position.set(Math.cos(angle) * 100, elevation * 100, 30);
    this.sun.target.position.set(0, 0, 0);

    const daylight = Math.max(0, elevation);
    this.sun.intensity = 1.5 * Math.pow(daylight, 0.6);
    this.hemi.intensity = 0.18 + 0.55 * daylight;

    this.sampleSky(t, this.skyColor);
    this.scene.background = this.skyColor;
    if (this.scene.fog) this.scene.fog.color.copy(this.skyColor);
  }

  private sampleSky(t: number, out: THREE.Color): void {
    for (let i = 0; i < KEYFRAMES.length - 1; i++) {
      const a = KEYFRAMES[i];
      const b = KEYFRAMES[i + 1];
      if (t >= a.t && t <= b.t) {
        const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
        out.copy(a.sky).lerp(b.sky, f);
        return;
      }
    }
    out.copy(KEYFRAMES[0].sky);
  }
}
