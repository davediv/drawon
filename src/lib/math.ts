import type { Vec2, Vec3 } from '../types';

export const clamp = (v: number, min: number, max: number): number =>
  v < min ? min : v > max ? max : v;

export const clamp01 = (v: number): number => clamp(v, 0, 1);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Where does `v` sit between `a` and `b`, clamped to 0..1?
 * Works when a > b, which is how the gesture scores invert "smaller is better"
 * measurements such as pinch distance.
 */
export function invLerp(a: number, b: number, v: number): number {
  if (a === b) return v >= b ? 1 : 0;
  return clamp01((v - a) / (b - a));
}

/** invLerp with a smooth (C1) ramp — avoids visible stepping in the nib arc. */
export function smoothRamp(a: number, b: number, v: number): number {
  const t = invLerp(a, b, v);
  return t * t * (3 - 2 * t);
}

export const dist2 = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);

export const dist3 = (a: Vec3, b: Vec3): number =>
  Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);

/**
 * Interior angle at `vertex` in degrees, in 3D.
 * 180 = perfectly straight joint, 0 = fully folded back on itself.
 */
export function angleAt(vertex: Vec3, a: Vec3, b: Vec3): number {
  const ax = a.x - vertex.x;
  const ay = a.y - vertex.y;
  const az = a.z - vertex.z;
  const bx = b.x - vertex.x;
  const by = b.y - vertex.y;
  const bz = b.z - vertex.z;

  const la = Math.hypot(ax, ay, az);
  const lb = Math.hypot(bx, by, bz);
  if (la < 1e-9 || lb < 1e-9) return 180;

  const cos = clamp((ax * bx + ay * by + az * bz) / (la * lb), -1, 1);
  return (Math.acos(cos) * 180) / Math.PI;
}

/** Exponential moving average, framerate-agnostic enough for HUD counters. */
export class Ema {
  private value: number | null = null;

  constructor(private readonly alpha: number) {}

  push(sample: number): number {
    this.value = this.value === null ? sample : this.alpha * sample + (1 - this.alpha) * this.value;
    return this.value;
  }

  get current(): number {
    return this.value ?? 0;
  }

  reset(): void {
    this.value = null;
  }
}
