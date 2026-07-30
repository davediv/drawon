import type { OneEuroConfig } from './lib/oneEuro';

/** Board units: 1000 = the full height of the camera frame. */
export const BOARD_HEIGHT = 1000;

export const CAMERA = {
  idealWidth: 1280,
  idealHeight: 720,
  idealFrameRate: 60,
} as const;

export const TRACKING = {
  numHands: 2,
  minHandDetectionConfidence: 0.55,
  minHandPresenceConfidence: 0.55,
  minTrackingConfidence: 0.55,
} as const;

export const GESTURE = {
  /** Pinch distance (÷ hand scale) at which the pen is fully "down". */
  pinchClosed: 0.34,
  /** Pinch distance at which the pen is fully "up". */
  pinchOpen: 0.62,

  /** Finger curl in degrees: at/below this the finger reads as extended. */
  extendedCurl: 42,
  /** At/above this the finger reads as folded. */
  foldedCurl: 105,

  /** Schmitt trigger — engage above, release below. The gap prevents flicker. */
  engageScore: 0.62,
  releaseScore: 0.42,

  /** Consecutive frames required to change state. ~2 frames = 33 ms at 60 fps. */
  engageFrames: 2,
  releaseFrames: 2,
} as const;

export const SMOOTHING = {
  /** Slider 0..1 maps onto these 1€ filter endpoints. */
  light: { minCutoff: 4.2, beta: 0.05, derivativeCutoff: 1 } satisfies OneEuroConfig,
  heavy: { minCutoff: 0.7, beta: 0.006, derivativeCutoff: 1 } satisfies OneEuroConfig,
  default: 0.55,
} as const;

export const STROKE = {
  /** Skip points closer than this (board units) — bounds stroke size and jitter. */
  minPointDistance: 1.6,
  /**
   * A jump larger than this between consecutive samples means the tracker
   * re-acquired a different hand position; break the stroke rather than draw
   * a wild straight line across the board.
   */
  maxJumpDistance: 190,
  /** Frames of tracking dropout tolerated before an in-progress stroke is closed. */
  lostFrameGrace: 3,
  minWidth: 2,
  maxWidth: 64,
  defaultPenWidth: 9,
  defaultEraserWidth: 42,
} as const;

export const PALETTE = [
  '#FF5227',
  '#FFC53D',
  '#4ADFD2',
  '#5B8CFF',
  '#C77DFF',
  '#4ADE80',
  '#FF6FA5',
  '#EAF0F6',
] as const;

export const DEFAULT_COLOR = PALETTE[2];
