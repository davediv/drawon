import { GESTURE } from '../config';
import { angleAt, dist3, smoothRamp } from '../lib/math';
import type { GestureMode, Vec3 } from '../types';
import { FINGER_JOINTS, LM, type FingerName } from './landmarks';

/**
 * Everything is measured on MediaPipe's *world* landmarks — metric 3D
 * coordinates relative to the hand's centre — rather than the projected image
 * landmarks. That matters: a finger curling toward the camera collapses to
 * almost nothing in 2D, so an image-space classifier reads it as extended and
 * the pen sticks down. In 3D the joint angle is unambiguous from any angle.
 */
export interface HandMetrics {
  /** Total flexion per finger in degrees. ~10 = straight, ~200 = fully folded. */
  curls: Record<FingerName, number>;
  /** Thumb-tip to index-tip distance, divided by hand size so it is user-independent. */
  pinch: number;
  /** Wrist to middle-knuckle distance in metres — the reference length. */
  handScale: number;
}

const FINGERS: readonly FingerName[] = ['thumb', 'index', 'middle', 'ring', 'pinky'];

function curlOf(world: Vec3[], finger: FingerName): number {
  const [a, b, c, d] = FINGER_JOINTS[finger];
  // Flexion at the two hinge joints, summed. Using both means a finger folded
  // only at the tip still reads as partially curled.
  const proximal = 180 - angleAt(world[b], world[a], world[c]);
  const distal = 180 - angleAt(world[c], world[b], world[d]);
  return proximal + distal;
}

export function measureHand(world: Vec3[]): HandMetrics {
  const handScale = Math.max(dist3(world[LM.WRIST], world[LM.MIDDLE_MCP]), 1e-4);

  const curls = {} as Record<FingerName, number>;
  for (const finger of FINGERS) curls[finger] = curlOf(world, finger);

  return {
    curls,
    pinch: dist3(world[LM.THUMB_TIP], world[LM.INDEX_TIP]) / handScale,
    handScale,
  };
}

/** 1 when the finger is straight, 0 when folded. */
const extended = (curl: number): number =>
  smoothRamp(GESTURE.foldedCurl, GESTURE.extendedCurl, curl);

/** 1 when the finger is folded, 0 when straight. */
const folded = (curl: number): number =>
  smoothRamp(GESTURE.extendedCurl, GESTURE.foldedCurl, curl);

export type GestureName = 'pinch' | 'point' | 'grip';

export interface GestureReading {
  /** 0..1 confidence that the user is holding a pen right now. */
  score: number;
  /** Which sub-gesture produced that score. */
  name: GestureName;
}

/** Thumb and index tips touching — a stylus grip. */
function pinchScore(m: HandMetrics): number {
  return smoothRamp(GESTURE.pinchOpen, GESTURE.pinchClosed, m.pinch);
}

/** Index extended, the rest folded away — a pointing finger. */
function pointScore(m: HandMetrics): number {
  return Math.min(
    extended(m.curls.index),
    folded(m.curls.middle),
    folded(m.curls.ring),
    folded(m.curls.pinky),
  );
}

/** A real pen grip: pinched, with the last two fingers tucked in. */
function gripScore(m: HandMetrics): number {
  return Math.min(pinchScore(m), folded(m.curls.ring), folded(m.curls.pinky));
}

export function scoreGesture(m: HandMetrics, mode: GestureMode): GestureReading {
  switch (mode) {
    case 'pinch':
      return { score: pinchScore(m), name: 'pinch' };
    case 'point':
      return { score: pointScore(m), name: 'point' };
    case 'grip':
      return { score: gripScore(m), name: 'grip' };
    case 'any': {
      const candidates: GestureReading[] = [
        { score: gripScore(m), name: 'grip' },
        { score: pinchScore(m), name: 'pinch' },
        { score: pointScore(m), name: 'point' },
      ];
      return candidates.reduce((best, c) => (c.score > best.score ? c : best));
    }
  }
}

/**
 * Turns a noisy confidence signal into a clean pen-down/pen-up state.
 *
 * Two mechanisms, because either alone is not enough: a Schmitt trigger (wide
 * gap between the engage and release thresholds) stops a score hovering at the
 * boundary from chattering, and a short frame count stops a single bad
 * detection from starting or ending a stroke. Release uses the same small frame
 * count as engage so letting go still feels instantaneous.
 */
export class PenTrigger {
  private down = false;
  private streak = 0;
  private edge: 'none' | 'press' | 'release' = 'none';

  update(score: number): boolean {
    this.edge = 'none';

    if (this.down) {
      if (score < GESTURE.releaseScore) {
        this.streak += 1;
        if (this.streak >= GESTURE.releaseFrames) {
          this.down = false;
          this.streak = 0;
          this.edge = 'release';
        }
      } else {
        this.streak = 0;
      }
    } else {
      if (score > GESTURE.engageScore) {
        this.streak += 1;
        if (this.streak >= GESTURE.engageFrames) {
          this.down = true;
          this.streak = 0;
          this.edge = 'press';
        }
      } else {
        this.streak = 0;
      }
    }

    return this.down;
  }

  get isDown(): boolean {
    return this.down;
  }

  /** True only on the frame the pen went down — used for the ink-charge cue. */
  get justPressed(): boolean {
    return this.edge === 'press';
  }

  get justReleased(): boolean {
    return this.edge === 'release';
  }

  reset(): void {
    this.down = false;
    this.streak = 0;
    this.edge = 'none';
  }
}
