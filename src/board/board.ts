import { STROKE } from '../config';
import type { FrameMapper } from '../tracking/frameMapper';
import type { BoardAction, BoardPoint, StrokeAction, Tool } from '../types';

const TAU = Math.PI * 2;

/**
 * Traces a stroke as a chain of quadratic curves whose control points are the
 * samples and whose endpoints are the midpoints between them. Two things fall
 * out of that: the curve is C1 continuous, so the line reads as one gesture
 * rather than a polyline, and widely spaced samples during a fast movement are
 * bridged by a curve instead of leaving a gap.
 */
function tracePath(ctx: CanvasRenderingContext2D, stroke: StrokeAction, mapper: FrameMapper): void {
  const pts = stroke.points;
  const n = pts.length;
  const width = Math.max(stroke.width * mapper.pixelsPerUnit, 0.6);

  if (n === 1) {
    const p = mapper.boardToStage(pts[0].x, pts[0].y);
    ctx.beginPath();
    ctx.arc(p.x, p.y, width / 2, 0, TAU);
    ctx.fill();
    return;
  }

  ctx.lineWidth = width;
  ctx.beginPath();

  const first = mapper.boardToStage(pts[0].x, pts[0].y);
  ctx.moveTo(first.x, first.y);

  if (n === 2) {
    const last = mapper.boardToStage(pts[1].x, pts[1].y);
    ctx.lineTo(last.x, last.y);
  } else {
    let current = mapper.boardToStage(pts[1].x, pts[1].y);
    for (let i = 1; i < n - 1; i += 1) {
      const next = mapper.boardToStage(pts[i + 1].x, pts[i + 1].y);
      ctx.quadraticCurveTo(current.x, current.y, (current.x + next.x) / 2, (current.y + next.y) / 2);
      current = next;
    }
    ctx.lineTo(current.x, current.y);
  }

  ctx.stroke();
}

function paintStroke(
  ctx: CanvasRenderingContext2D,
  stroke: StrokeAction,
  mapper: FrameMapper,
): void {
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (stroke.tool === 'eraser') {
    // Erasing punches a hole in the ink layer rather than painting background
    // over it, which is what keeps the whiteboard transparent over the video.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = '#000';
    ctx.fillStyle = '#000';
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
  }

  tracePath(ctx, stroke, mapper);
  ctx.restore();
}

export function paintActions(
  ctx: CanvasRenderingContext2D,
  actions: readonly BoardAction[],
  mapper: FrameMapper,
  width: number,
  height: number,
): void {
  ctx.clearRect(0, 0, width, height);
  for (const action of actions) {
    if (action.kind === 'clear') ctx.clearRect(0, 0, width, height);
    else paintStroke(ctx, action, mapper);
  }
}

export interface BoardStats {
  strokes: number;
  canUndo: boolean;
  canRedo: boolean;
}

/**
 * Holds the drawing as a list of vector actions and keeps a rasterised cache of
 * the finished ones. Finished strokes are painted into the cache exactly once;
 * only in-progress strokes are re-traced each frame. Undo, redo, clear and
 * window resizes replay the action list, which is also what makes undo work
 * across an erase or a clear.
 */
export class Board {
  private actions: BoardAction[] = [];
  private redoStack: BoardAction[] = [];
  private readonly active = new Map<number, StrokeAction>();

  private readonly cache: HTMLCanvasElement;
  private readonly cacheCtx: CanvasRenderingContext2D;
  private cacheStale = true;
  /** The mapper the cache was rasterised with; null until the first render. */
  private cacheMapper: FrameMapper | null = null;
  /** Cache dimensions in CSS pixels — its context carries the DPR transform. */
  private cacheWidth = 0;
  private cacheHeight = 0;

  /** Bumped whenever the visible result would differ — the app uses it to skip redraws. */
  version = 0;

  onChange: ((stats: BoardStats) => void) | null = null;

  constructor() {
    this.cache = document.createElement('canvas');
    const ctx = this.cache.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is unavailable in this browser.');
    this.cacheCtx = ctx;
  }

  /**
   * `strokes` counts what is currently *visible*, not everything ever drawn —
   * a clear resets it to zero. Clear and Save key off this, and both should be
   * dead on an empty board even though the history behind it is still intact.
   */
  get stats(): BoardStats {
    let visible = 0;
    for (const action of this.actions) {
      if (action.kind === 'clear') visible = 0;
      else visible += 1;
    }
    return {
      strokes: visible,
      canUndo: this.actions.length > 0,
      canRedo: this.redoStack.length > 0,
    };
  }

  get activeStrokes(): IterableIterator<StrokeAction> {
    return this.active.values();
  }

  get hasActiveStrokes(): boolean {
    return this.active.size > 0;
  }

  hasActiveStroke(handId: number): boolean {
    return this.active.has(handId);
  }

  getActions(): readonly BoardAction[] {
    return this.actions;
  }

  /** @param dpr device pixel ratio — the cache renders at full device resolution. */
  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const pixelWidth = Math.max(Math.round(cssWidth * dpr), 1);
    const pixelHeight = Math.max(Math.round(cssHeight * dpr), 1);
    if (this.cache.width === pixelWidth && this.cache.height === pixelHeight) return;

    this.cache.width = pixelWidth;
    this.cache.height = pixelHeight;
    this.cacheWidth = cssWidth;
    this.cacheHeight = cssHeight;
    // Resizing a canvas resets its context, so the DPR transform is reapplied
    // here. Everything downstream can then work in CSS pixels.
    this.cacheCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.cacheStale = true;
    this.version += 1;
  }

  // ---- stroke lifecycle -------------------------------------------------

  beginStroke(handId: number, tool: Tool, color: string, width: number, at: BoardPoint): void {
    this.active.set(handId, { kind: 'stroke', tool, color, width, points: [at] });
    this.version += 1;
  }

  /** @returns false when the sample was rejected, which ends the stroke. */
  extendStroke(handId: number, at: BoardPoint): boolean {
    const stroke = this.active.get(handId);
    if (!stroke) return false;

    const last = stroke.points[stroke.points.length - 1];
    const distance = Math.hypot(at.x - last.x, at.y - last.y);

    if (distance > STROKE.maxJumpDistance) return false;
    if (distance < STROKE.minPointDistance) return true;

    stroke.points.push(at);
    this.version += 1;
    return true;
  }

  endStroke(handId: number): void {
    const stroke = this.active.get(handId);
    if (!stroke) return;
    this.active.delete(handId);
    this.pushAction(stroke);
  }

  cancelStroke(handId: number): void {
    if (this.active.delete(handId)) this.version += 1;
  }

  endAllStrokes(): void {
    for (const handId of [...this.active.keys()]) this.endStroke(handId);
  }

  // ---- history ----------------------------------------------------------

  clear(): void {
    this.endAllStrokes();
    // Nothing on screen means nothing to clear — do not stack redundant clears.
    if (this.stats.strokes === 0) return;
    // Recorded as an action so that clearing is undoable like anything else.
    this.pushAction({ kind: 'clear' });
  }

  undo(): void {
    this.endAllStrokes();
    const action = this.actions.pop();
    if (!action) return;
    this.redoStack.push(action);
    this.cacheStale = true;
    this.version += 1;
    this.notify();
  }

  redo(): void {
    const action = this.redoStack.pop();
    if (!action) return;
    this.actions.push(action);
    this.applyToCache(action);
    this.version += 1;
    this.notify();
  }

  private pushAction(action: BoardAction): void {
    this.actions.push(action);
    this.redoStack.length = 0;
    this.applyToCache(action);
    this.version += 1;
    this.notify();
  }

  /** Appending never needs a replay — only removal does. */
  private applyToCache(action: BoardAction): void {
    if (this.cacheStale) return;
    if (!this.cacheMapper) {
      this.cacheStale = true;
      return;
    }
    if (action.kind === 'clear') {
      this.cacheCtx.clearRect(0, 0, this.cacheWidth, this.cacheHeight);
    } else {
      paintStroke(this.cacheCtx, action, this.cacheMapper);
    }
  }

  private notify(): void {
    this.onChange?.(this.stats);
  }

  // ---- rendering --------------------------------------------------------

  /**
   * Draws finished ink plus any in-progress strokes onto the visible ink layer.
   * All dimensions are CSS pixels; both contexts carry the DPR transform.
   */
  render(ctx: CanvasRenderingContext2D, mapper: FrameMapper, width: number, height: number): void {
    this.cacheMapper = mapper;

    if (this.cacheStale) {
      paintActions(this.cacheCtx, this.actions, mapper, this.cacheWidth, this.cacheHeight);
      this.cacheStale = false;
    }

    ctx.clearRect(0, 0, width, height);
    if (this.cache.width > 0 && this.cache.height > 0) {
      ctx.drawImage(this.cache, 0, 0, this.cacheWidth, this.cacheHeight);
    }
    for (const stroke of this.active.values()) paintStroke(ctx, stroke, mapper);
  }

  /** Forces a replay on the next render — call after a resize or a mapper change. */
  invalidate(): void {
    this.cacheStale = true;
    this.version += 1;
  }
}
