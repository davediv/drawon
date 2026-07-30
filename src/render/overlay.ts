import { clamp01, lerp } from '../lib/math';
import type { FrameMapper } from '../tracking/frameMapper';
import { FINGER_BONES, LM, PALM_BONES, type FingerName } from '../tracking/landmarks';
import type { HandPointer } from '../tracking/pointers';
import type { Tool } from '../types';
import { withAlpha } from './color';

const TAU = Math.PI * 2;
const CHARGE_MS = 170;

export interface OverlayOptions {
  showSkeleton: boolean;
  tool: Tool;
  color: string;
  /** Current brush size in board units. */
  brush: number;
  /** performance.now() for time-based cues. */
  now: number;
  trace: string;
  dim: string;
  paper: string;
}

const OTHER_FINGERS: readonly FingerName[] = ['thumb', 'middle', 'ring', 'pinky'];

/**
 * Draws everything that is not ink: the tracked hand skeleton and the nib.
 *
 * The nib is deliberately more than a dot. Air-drawing has no physical
 * feedback, so the cursor has to answer three questions at a glance: where the
 * pen is, how thick the line will be (the ring is the true stroke width), and
 * how close the gesture is to engaging (the arc). Without that last one, a
 * gesture that nearly fires just feels broken.
 */
export class OverlayRenderer {
  private readonly charges = new Map<number, number>();

  render(
    ctx: CanvasRenderingContext2D,
    mapper: FrameMapper,
    pointers: readonly HandPointer[],
    options: OverlayOptions,
    width: number,
    height: number,
  ): void {
    ctx.clearRect(0, 0, width, height);
    if (!mapper.ready) return;

    for (const pointer of pointers) {
      if (pointer.justPressed) this.charges.set(pointer.id, options.now);
      if (options.showSkeleton) this.drawSkeleton(ctx, mapper, pointer, options);
      if (!pointer.isDown) this.drawTrail(ctx, mapper, pointer, options);
    }

    // Nibs last so they sit above every skeleton when hands overlap.
    for (const pointer of pointers) this.drawNib(ctx, mapper, pointer, options);
  }

  private drawSkeleton(
    ctx: CanvasRenderingContext2D,
    mapper: FrameMapper,
    pointer: HandPointer,
    options: OverlayOptions,
  ): void {
    const project = (index: number): { x: number; y: number } => {
      const lm = pointer.landmarks[index];
      return mapper.normalizedToStage(lm.x, lm.y);
    };

    // Step back while drawing so the skeleton never competes with the stroke.
    const fade = pointer.isDown ? 0.45 : 1;

    ctx.save();
    ctx.lineCap = 'round';

    const bone = (
      pairs: ReadonlyArray<readonly [number, number]>,
      alpha: number,
      lineWidth: number,
      color: string,
    ): void => {
      ctx.strokeStyle = withAlpha(color, alpha * fade);
      ctx.lineWidth = lineWidth;
      ctx.beginPath();
      for (const [a, b] of pairs) {
        const from = project(a);
        const to = project(b);
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
      }
      ctx.stroke();
    };

    bone(PALM_BONES, 0.28, 1.25, options.trace);
    for (const finger of OTHER_FINGERS) bone(FINGER_BONES[finger], 0.28, 1.25, options.trace);
    // The index chain is the one that matters — it carries the nib.
    bone(FINGER_BONES.index, 0.85, 1.75, options.trace);

    ctx.fillStyle = withAlpha(options.trace, 0.5 * fade);
    for (let i = 0; i < pointer.landmarks.length; i += 1) {
      if (i === LM.INDEX_TIP) continue;
      const p = project(i);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.9, 0, TAU);
      ctx.fill();
    }

    ctx.restore();
  }

  private drawTrail(
    ctx: CanvasRenderingContext2D,
    mapper: FrameMapper,
    pointer: HandPointer,
    options: OverlayOptions,
  ): void {
    const trail = pointer.trail;
    if (trail.length < 3) return;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineWidth = 1.5;

    for (let i = 1; i < trail.length; i += 1) {
      const t = i / (trail.length - 1);
      const from = mapper.boardToStage(trail[i - 1].x, trail[i - 1].y);
      const to = mapper.boardToStage(trail[i].x, trail[i].y);
      ctx.strokeStyle = withAlpha(options.trace, 0.22 * t * t);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    }

    ctx.restore();
  }

  private drawNib(
    ctx: CanvasRenderingContext2D,
    mapper: FrameMapper,
    pointer: HandPointer,
    options: OverlayOptions,
  ): void {
    const p = mapper.boardToStage(pointer.tip.x, pointer.tip.y);
    const isEraser = options.tool === 'eraser';
    const accent = isEraser ? options.paper : options.color;
    const radius = Math.max((options.brush * mapper.pixelsPerUnit) / 2, 7);
    const down = pointer.isDown;

    ctx.save();
    ctx.lineCap = 'butt';

    // Ring — its radius is the actual stroke width, so you can size a line
    // before committing to it.
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, TAU);
    if (down && !isEraser) {
      ctx.fillStyle = withAlpha(accent, 0.16);
      ctx.fill();
    }
    ctx.setLineDash(down ? [] : [3, 4]);
    ctx.strokeStyle = withAlpha(accent, down ? 0.95 : 0.5);
    ctx.lineWidth = down ? 1.75 : 1;
    ctx.stroke();
    ctx.setLineDash([]);

    // Confidence arc — how close the gesture is to engaging.
    if (!down && pointer.score > 0.02) {
      const sweep = clamp01(pointer.score) * TAU;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius + 6, -Math.PI / 2, -Math.PI / 2 + sweep);
      ctx.strokeStyle = withAlpha(accent, lerp(0.25, 0.9, clamp01(pointer.score)));
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Registration ticks, retracted while the pen is down.
    const tickInner = down ? radius + 3 : radius + 10;
    const tickOuter = down ? radius + 7 : radius + 17;
    ctx.strokeStyle = withAlpha(down ? accent : options.dim, down ? 0.8 : 0.55);
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < 4; i += 1) {
      const angle = (i * TAU) / 4;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      ctx.moveTo(p.x + cos * tickInner, p.y + sin * tickInner);
      ctx.lineTo(p.x + cos * tickOuter, p.y + sin * tickOuter);
    }
    ctx.stroke();

    // Centre: a filled point once inking, a hairline cross while hovering.
    if (down) {
      ctx.fillStyle = withAlpha(accent, 1);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2, 0, TAU);
      ctx.fill();
    } else {
      ctx.strokeStyle = withAlpha(accent, 0.8);
      ctx.beginPath();
      ctx.moveTo(p.x - 3.5, p.y);
      ctx.lineTo(p.x + 3.5, p.y);
      ctx.moveTo(p.x, p.y - 3.5);
      ctx.lineTo(p.x, p.y + 3.5);
      ctx.stroke();
    }

    this.drawCharge(ctx, pointer.id, p, radius, accent, options.now);
    ctx.restore();
  }

  /** One-shot ring that collapses into the nib the instant the pen engages. */
  private drawCharge(
    ctx: CanvasRenderingContext2D,
    id: number,
    p: { x: number; y: number },
    radius: number,
    accent: string,
    now: number,
  ): void {
    const startedAt = this.charges.get(id);
    if (startedAt === undefined) return;

    const t = (now - startedAt) / CHARGE_MS;
    if (t >= 1) {
      this.charges.delete(id);
      return;
    }

    const eased = 1 - (1 - t) ** 3;
    ctx.beginPath();
    ctx.arc(p.x, p.y, lerp(radius * 3, radius, eased), 0, TAU);
    ctx.strokeStyle = withAlpha(accent, (1 - t) * 0.9);
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  reset(): void {
    this.charges.clear();
  }
}
