import { el } from './dom';

export interface HudReading {
  state: string;
  fps: number;
  trackMs: number;
  pipeMs: number;
  hands: number;
}

/**
 * Numbers change every frame; the DOM does not need to. Repainting text at
 * 60 Hz costs more than the tracking does, so readouts settle at ~6 Hz.
 */
export class Hud {
  private readonly state = el('v-state');
  private readonly fps = el('v-fps');
  private readonly track = el('v-track');
  private readonly pipe = el('v-pipe');
  private readonly hands = el('v-hands');
  private readonly meta = el('stage-meta');

  private lastPaint = 0;
  private lastState = '';

  update(reading: HudReading, now: number): void {
    if (reading.state !== this.lastState) {
      this.state.textContent = reading.state;
      this.lastState = reading.state;
    }

    if (now - this.lastPaint < 160) return;
    this.lastPaint = now;

    this.fps.textContent = reading.fps > 0 ? String(Math.round(reading.fps)) : '—';
    this.track.textContent = reading.trackMs > 0 ? `${reading.trackMs.toFixed(1)}ms` : '—';
    this.pipe.textContent = reading.pipeMs > 0 ? `${Math.round(reading.pipeMs)}ms` : '—';
    this.hands.textContent = String(reading.hands);
  }

  setMeta(text: string): void {
    this.meta.textContent = text;
  }

  reset(): void {
    this.fps.textContent = '—';
    this.track.textContent = '—';
    this.pipe.textContent = '—';
    this.hands.textContent = '0';
  }
}
