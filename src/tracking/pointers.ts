import type { HandLandmarkerResult, NormalizedLandmark } from '@mediapipe/tasks-vision';
import { SMOOTHING, STROKE } from '../config';
import { OneEuroPoint, type OneEuroConfig } from '../lib/oneEuro';
import type { BoardPoint, GestureMode, Vec3 } from '../types';
import type { FrameMapper } from './frameMapper';
import { measureHand, PenTrigger, scoreGesture, type GestureName, type HandMetrics } from './gesture';
import { LM } from './landmarks';

/** Slider 0..1 to filter constants, interpolated geometrically so the feel is even. */
export function smoothingConfig(amount: number): OneEuroConfig {
  const t = Math.min(Math.max(amount, 0), 1);
  const { light, heavy } = SMOOTHING;
  const geo = (a: number, b: number): number => a * (b / a) ** t;
  return {
    minCutoff: geo(light.minCutoff, heavy.minCutoff),
    beta: geo(light.beta, heavy.beta),
    derivativeCutoff: light.derivativeCutoff,
  };
}

export interface HandPointer {
  id: number;
  /** 'Left' | 'Right' as reported by the model, already un-mirrored by MediaPipe. */
  handedness: string;
  landmarks: NormalizedLandmark[];
  metrics: HandMetrics;
  /** Smoothed index-fingertip position, in board units — this is the pen nib. */
  tip: BoardPoint;
  /** Raw, unsmoothed nib position; used to measure how much filtering is doing. */
  rawTip: BoardPoint;
  score: number;
  gesture: GestureName;
  isDown: boolean;
  justPressed: boolean;
  justReleased: boolean;
  /** Recent nib positions in board units, newest last. */
  trail: BoardPoint[];
}

interface Slot {
  id: number;
  filter: OneEuroPoint;
  trigger: PenTrigger;
  trail: BoardPoint[];
  lastWrist: { x: number; y: number };
  lastSeenFrame: number;
}

const TRAIL_LENGTH = 16;
/** Normalized-space radius within which a detection is considered the same hand. */
const MATCH_RADIUS = 0.28;

export interface PointerUpdate {
  mapper: FrameMapper;
  gestureMode: GestureMode;
  smoothing: number;
  /** Monotonic seconds, for the 1€ filter. */
  time: number;
  frame: number;
}

/**
 * Turns per-frame detections into stable, smoothed pen pointers.
 *
 * MediaPipe hands out an array with no identity guarantee across frames, so
 * detections are matched to existing slots by wrist proximity. Identity matters
 * here: each slot carries its own filter state and pen-down latch, and mixing
 * two hands' histories would teleport a stroke between them.
 */
export class PointerTracker {
  private slots: Slot[] = [];
  private nextId = 1;
  private smoothing: number = SMOOTHING.default;

  /** Slots dropped this frame, so the caller can close their strokes. */
  readonly retired: number[] = [];

  update(result: HandLandmarkerResult | null, options: PointerUpdate): HandPointer[] {
    this.retired.length = 0;

    if (options.smoothing !== this.smoothing) {
      this.smoothing = options.smoothing;
      const config = smoothingConfig(this.smoothing);
      for (const slot of this.slots) slot.filter.configure(config);
    }

    const pointers: HandPointer[] = [];
    const hands = result?.landmarks ?? [];
    const claimed = new Set<number>();

    for (let i = 0; i < hands.length; i += 1) {
      const landmarks = hands[i];
      const world = result?.worldLandmarks?.[i] as Vec3[] | undefined;
      if (!landmarks || !world || landmarks.length < 21 || world.length < 21) continue;

      const wrist = landmarks[LM.WRIST];
      const slot = this.acquireSlot(wrist, claimed, options.frame);

      const metrics = measureHand(world);
      const reading = scoreGesture(metrics, options.gestureMode);
      const isDown = slot.trigger.update(reading.score);

      const tipLandmark = landmarks[LM.INDEX_TIP];
      const raw = options.mapper.normalizedToBoard(tipLandmark.x, tipLandmark.y);
      const smoothed = slot.filter.filter(raw.x, raw.y, options.time);

      slot.trail.push(smoothed);
      if (slot.trail.length > TRAIL_LENGTH) slot.trail.shift();

      pointers.push({
        id: slot.id,
        handedness: result?.handedness?.[i]?.[0]?.categoryName ?? '',
        landmarks,
        metrics,
        tip: smoothed,
        rawTip: raw,
        score: reading.score,
        gesture: reading.name,
        isDown,
        justPressed: slot.trigger.justPressed,
        justReleased: slot.trigger.justReleased,
        trail: slot.trail,
      });
    }

    this.retireStaleSlots(options.frame);
    return pointers;
  }

  private acquireSlot(
    wrist: NormalizedLandmark,
    claimed: Set<number>,
    frame: number,
  ): Slot {
    let best: Slot | null = null;
    let bestDistance = MATCH_RADIUS;

    for (const slot of this.slots) {
      if (claimed.has(slot.id)) continue;
      const distance = Math.hypot(wrist.x - slot.lastWrist.x, wrist.y - slot.lastWrist.y);
      if (distance < bestDistance) {
        best = slot;
        bestDistance = distance;
      }
    }

    if (!best) {
      best = {
        id: this.nextId++,
        filter: new OneEuroPoint(smoothingConfig(this.smoothing)),
        trigger: new PenTrigger(),
        trail: [],
        lastWrist: { x: wrist.x, y: wrist.y },
        lastSeenFrame: frame,
      };
      this.slots.push(best);
    }

    claimed.add(best.id);
    best.lastWrist = { x: wrist.x, y: wrist.y };
    best.lastSeenFrame = frame;
    return best;
  }

  /**
   * A hand that vanishes for a frame or two is almost always a detection blip,
   * not the user lowering their hand. Holding the slot open across that gap
   * stops a single dropped frame from chopping a stroke in half.
   */
  private retireStaleSlots(frame: number): void {
    this.slots = this.slots.filter((slot) => {
      if (frame - slot.lastSeenFrame <= STROKE.lostFrameGrace) return true;
      this.retired.push(slot.id);
      return false;
    });
  }

  /** Drops all identity and filter state. Callers must close any open strokes themselves. */
  reset(): void {
    this.slots = [];
    this.retired.length = 0;
  }
}
