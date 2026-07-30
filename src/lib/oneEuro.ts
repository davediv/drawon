/**
 * 1€ filter (Casiez, Roussel & Vogel, CHI 2012).
 *
 * A plain low-pass filter forces a choice between jitter and lag. This one
 * adapts its cutoff to speed: it filters hard while the hand is nearly still
 * (killing tracker jitter) and opens up as the hand accelerates (so fast
 * strokes stay latency-free). That property is the reason air-drawing feels
 * attached to your fingertip instead of dragging behind it.
 */

function alphaFor(cutoffHz: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dt);
}

class LowPass {
  private state: number | null = null;

  filter(value: number, alpha: number): number {
    this.state = this.state === null ? value : alpha * value + (1 - alpha) * this.state;
    return this.state;
  }

  get hasValue(): boolean {
    return this.state !== null;
  }

  reset(): void {
    this.state = null;
  }
}

export interface OneEuroConfig {
  /** Cutoff at zero speed, in Hz. Lower = steadier, but laggier. */
  minCutoff: number;
  /** How aggressively the cutoff opens with speed. Higher = less lag. */
  beta: number;
  /** Cutoff for the derivative estimate itself. */
  derivativeCutoff: number;
}

export class OneEuroFilter {
  private readonly value = new LowPass();
  private readonly derivative = new LowPass();
  private lastValue = 0;
  private lastTime: number | null = null;

  constructor(private config: OneEuroConfig) {}

  configure(config: Partial<OneEuroConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /** @param time seconds (monotonic) */
  filter(value: number, time: number): number {
    if (this.lastTime === null) {
      this.lastTime = time;
      this.lastValue = value;
      return this.value.filter(value, 1);
    }

    // Guard against duplicate timestamps and against a stalled tab producing a
    // huge dt, which would otherwise make alpha ~1 and pass jitter straight through.
    const dt = Math.min(Math.max(time - this.lastTime, 1 / 240), 1 / 5);
    this.lastTime = time;

    const speed = (value - this.lastValue) / dt;
    this.lastValue = value;

    const smoothedSpeed = this.derivative.filter(
      speed,
      alphaFor(this.config.derivativeCutoff, dt),
    );

    const cutoff = this.config.minCutoff + this.config.beta * Math.abs(smoothedSpeed);
    return this.value.filter(value, alphaFor(cutoff, dt));
  }

  reset(): void {
    this.value.reset();
    this.derivative.reset();
    this.lastTime = null;
    this.lastValue = 0;
  }
}

/** Two independent 1€ filters, for a 2D point. */
export class OneEuroPoint {
  private readonly fx: OneEuroFilter;
  private readonly fy: OneEuroFilter;

  constructor(config: OneEuroConfig) {
    this.fx = new OneEuroFilter(config);
    this.fy = new OneEuroFilter(config);
  }

  configure(config: Partial<OneEuroConfig>): void {
    this.fx.configure(config);
    this.fy.configure(config);
  }

  filter(x: number, y: number, time: number): { x: number; y: number } {
    return { x: this.fx.filter(x, time), y: this.fy.filter(y, time) };
  }

  reset(): void {
    this.fx.reset();
    this.fy.reset();
  }
}
