export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type Tool = 'pen' | 'eraser';

/**
 * How the app decides you are "holding a pen".
 * - `pinch` : thumb tip and index tip touch (stylus grip)
 * - `point` : index extended, other fingers curled
 * - `grip`  : pinch *and* ring + pinky curled — strictest, fewest false starts
 * - `any`   : whichever of the above fires first
 */
export type GestureMode = 'pinch' | 'point' | 'grip' | 'any';

/**
 * Stroke points live in aspect-corrected camera space, not screen pixels, so a
 * window resize re-maps the artwork instead of distorting it. See `FrameMapper`.
 */
export interface BoardPoint {
  x: number;
  y: number;
}

export interface StrokeAction {
  kind: 'stroke';
  tool: Tool;
  color: string;
  /** Width in board units (1000 = full camera-frame height). */
  width: number;
  points: BoardPoint[];
}

export interface ClearAction {
  kind: 'clear';
}

export type BoardAction = StrokeAction | ClearAction;
