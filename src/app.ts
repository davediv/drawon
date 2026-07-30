import { Board } from './board/board';
import { downloadBlob, exportPng, timestampedName, type ExportMode } from './board/export';
import { Ema } from './lib/math';
import { OverlayRenderer } from './render/overlay';
import { Camera, CameraError } from './tracking/camera';
import { FrameMapper } from './tracking/frameMapper';
import { HandTracker } from './tracking/handTracker';
import { PointerTracker, type HandPointer } from './tracking/pointers';
import { Controls } from './ui/controls';
import { el } from './ui/dom';
import { Hud } from './ui/hud';
import type { Settings } from './ui/settings';

const MAX_DPR = 2;

const IDLE_GATE = {
  title: 'Draw in the air',
  body:
    'Hold your hand up as if you were pinching a pen. Your index fingertip becomes the nib — ' +
    'move it and it inks. Open the pinch and it stops.',
  action: 'Start camera',
  fine: 'Video never leaves your browser',
} as const;

export class App {
  private readonly stage = el('stage');
  private readonly video = el<HTMLVideoElement>('video');
  private readonly inkCanvas = el<HTMLCanvasElement>('ink');
  private readonly overlayCanvas = el<HTMLCanvasElement>('overlay');
  private readonly inkCtx: CanvasRenderingContext2D;
  private readonly overlayCtx: CanvasRenderingContext2D;

  private readonly camera = new Camera(this.video);
  private readonly tracker = new HandTracker();
  private readonly pointers = new PointerTracker();
  private readonly mapper = new FrameMapper();
  private readonly board = new Board();
  private readonly overlay = new OverlayRenderer();
  private readonly hud = new Hud();
  private readonly controls: Controls;

  private readonly fpsMeter = new Ema(0.1);
  private readonly trackMeter = new Ema(0.1);
  private readonly pipeMeter = new Ema(0.1);

  private running = false;
  private frame = 0;
  private frameHandle = 0;
  private useRvfc = false;
  private lastFrameTime = 0;
  private lastMediaTime = -1;
  private lastPointers: HandPointer[] = [];
  private lastInkVersion = -1;
  private wasDrawing = false;

  private stageWidth = 0;
  private stageHeight = 0;
  private dpr = 1;

  constructor() {
    const inkCtx = this.inkCanvas.getContext('2d');
    const overlayCtx = this.overlayCanvas.getContext('2d');
    if (!inkCtx || !overlayCtx) throw new Error('Canvas 2D is unavailable in this browser.');
    this.inkCtx = inkCtx;
    this.overlayCtx = overlayCtx;

    this.controls = new Controls({
      onSettingsChange: (settings, key) => this.onSettingsChange(settings, key),
      onUndo: () => this.withHistory(() => this.board.undo()),
      onRedo: () => this.withHistory(() => this.board.redo()),
      onClear: () => this.clear(),
      onSave: (mode) => void this.save(mode),
      onStart: () => void this.start(),
    });

    this.board.onChange = (stats) => this.controls.setHistory(stats);
    this.controls.setHistory(this.board.stats);
    this.controls.setGate('idle', IDLE_GATE);

    this.observeStage();
    window.addEventListener('resize', () => this.layout());
    document.addEventListener('visibilitychange', () => this.onVisibilityChange());
    window.addEventListener('beforeunload', () => this.stop());

    this.layout();
    this.renderOnce();
  }

  // ---- lifecycle --------------------------------------------------------

  async start(): Promise<void> {
    this.controls.setGate('busy', {
      title: 'Starting up',
      body: 'Waiting for camera access…',
      fine: '',
    });

    try {
      await this.camera.start(this.controls.settings.cameraId || undefined);

      if (!this.tracker.ready) {
        this.controls.setGate('busy', {
          title: 'Starting up',
          body: 'Loading the hand model — about 8 MB, once.',
          fine: '',
        });
        await this.tracker.load((message) => {
          this.controls.setGate('busy', { title: 'Starting up', body: `${message}…`, fine: '' });
        });
      }

      const devices = await this.camera.listCameras();
      this.controls.setCameras(devices, this.controls.settings.cameraId);

      this.controls.setGate('hidden');
      this.stage.classList.add('stage--live');
      this.layout();
      this.beginLoop();
      this.updateMeta();
    } catch (error) {
      this.stop();
      this.stage.classList.remove('stage--live');
      const failure =
        error instanceof CameraError
          ? error
          : new CameraError(
              'Setup failed',
              error instanceof Error ? error.message : 'Unknown error.',
            );
      this.controls.setGate('error', {
        title: failure.message,
        body: failure.hint,
        action: 'Try again',
      });
    }
  }

  stop(): void {
    this.running = false;
    this.cancelFrame();
    this.board.endAllStrokes();
    this.pointers.reset();
    this.lastPointers = [];
    this.camera.stop();
    this.stage.classList.remove('stage--live', 'stage--drawing');
    this.hud.reset();
  }

  private beginLoop(): void {
    if (this.running) return;
    this.running = true;
    this.useRvfc = typeof this.video.requestVideoFrameCallback === 'function';
    this.lastFrameTime = 0;
    this.lastMediaTime = -1;
    this.fpsMeter.reset();
    this.scheduleFrame();
  }

  private scheduleFrame(): void {
    if (!this.running) return;
    if (this.useRvfc) {
      // One callback per decoded camera frame: no duplicate inference, and the
      // shortest possible path from capture to ink.
      this.frameHandle = this.video.requestVideoFrameCallback!((now, metadata) =>
        this.tick(now, metadata),
      );
    } else {
      this.frameHandle = requestAnimationFrame((now) => this.tick(now));
    }
  }

  private cancelFrame(): void {
    if (!this.frameHandle) return;
    if (this.useRvfc) this.video.cancelVideoFrameCallback?.(this.frameHandle);
    else cancelAnimationFrame(this.frameHandle);
    this.frameHandle = 0;
  }

  private onVisibilityChange(): void {
    if (document.hidden) {
      // A backgrounded tab stops delivering frames; close any open stroke so it
      // does not resume with a line jumping across the board.
      this.board.endAllStrokes();
      return;
    }
    // Filter state is stale after a long gap — start clean rather than smoothing
    // across minutes of missing samples.
    this.pointers.reset();
    this.lastFrameTime = 0;
  }

  // ---- layout -----------------------------------------------------------

  private observeStage(): void {
    if (typeof ResizeObserver === 'undefined') return;
    new ResizeObserver(() => this.layout()).observe(this.stage);
  }

  private layout(): void {
    const rect = this.stage.getBoundingClientRect();
    const width = Math.max(Math.round(rect.width), 1);
    const height = Math.max(Math.round(rect.height), 1);
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);

    if (width === this.stageWidth && height === this.stageHeight && dpr === this.dpr) {
      this.syncMapper();
      return;
    }

    this.stageWidth = width;
    this.stageHeight = height;
    this.dpr = dpr;

    for (const [canvas, ctx] of [
      [this.inkCanvas, this.inkCtx],
      [this.overlayCanvas, this.overlayCtx],
    ] as const) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    this.board.resize(width, height, dpr);
    this.syncMapper();
    this.renderOnce();
  }

  private syncMapper(): void {
    this.mapper.configure(
      this.video.videoWidth,
      this.video.videoHeight,
      this.stageWidth,
      this.stageHeight,
      this.controls.settings.mirror,
    );
    this.board.invalidate();
  }

  // ---- frame ------------------------------------------------------------

  private tick(now: number, metadata?: VideoFrameCallbackMetadata): void {
    this.scheduleFrame();
    if (!this.running) return;

    try {
      this.step(now, metadata);
    } catch (error) {
      // One bad frame should never take the whole session down.
      console.error('Frame failed', error);
    }
  }

  private step(now: number, metadata?: VideoFrameCallbackMetadata): void {
    if (this.lastFrameTime > 0) {
      const delta = now - this.lastFrameTime;
      if (delta > 0 && delta < 500) this.fpsMeter.push(1000 / delta);
    }
    this.lastFrameTime = now;

    if (this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

    if (this.mapper.videoWidth !== this.video.videoWidth) {
      this.syncMapper();
      this.updateMeta();
    }

    // Without rVFC the loop runs at display rate, which can be double the camera
    // rate. Re-running inference on an identical frame would burn time for
    // nothing, so only the render half repeats.
    const mediaTime = this.video.currentTime;
    const isNewFrame = this.useRvfc || mediaTime !== this.lastMediaTime;
    this.lastMediaTime = mediaTime;

    if (isNewFrame) {
      const started = performance.now();
      const result = this.tracker.detect(this.video, started);
      this.trackMeter.push(performance.now() - started);

      this.frame += 1;
      this.lastPointers = this.pointers.update(result, {
        mapper: this.mapper,
        gestureMode: this.controls.settings.gestureMode,
        smoothing: this.controls.settings.smoothing,
        time: now / 1000,
        frame: this.frame,
      });

      for (const id of this.pointers.retired) this.board.endStroke(id);
      for (const pointer of this.lastPointers) this.applyPointer(pointer);
    }

    this.draw(now);

    const origin = metadata?.captureTime ?? metadata?.presentationTime;
    if (origin !== undefined) {
      const pipe = performance.now() - origin;
      if (pipe >= 0 && pipe < 500) this.pipeMeter.push(pipe);
    }

    this.hud.update(
      {
        state: this.board.hasActiveStrokes ? 'inking' : 'live',
        fps: this.fpsMeter.current,
        trackMs: this.trackMeter.current,
        pipeMs: this.pipeMeter.current,
        hands: this.lastPointers.length,
      },
      now,
    );
  }

  /** Translates one hand's pen state into stroke mutations. */
  private applyPointer(pointer: HandPointer): void {
    const { tool, color } = this.controls.settings;
    const width = this.controls.activeWidth;

    if (!pointer.isDown) {
      this.board.endStroke(pointer.id);
      return;
    }

    if (!this.board.hasActiveStroke(pointer.id)) {
      this.board.beginStroke(pointer.id, tool, color, width, pointer.tip);
      return;
    }

    if (!this.board.extendStroke(pointer.id, pointer.tip)) {
      // The sample was too far from the last one to be the same movement.
      // Close the stroke and start a fresh one at the new position.
      this.board.endStroke(pointer.id);
      this.board.beginStroke(pointer.id, tool, color, width, pointer.tip);
    }
  }

  private draw(now: number): void {
    if (this.board.version !== this.lastInkVersion) {
      this.board.render(this.inkCtx, this.mapper, this.stageWidth, this.stageHeight);
      this.lastInkVersion = this.board.version;
    }

    const settings = this.controls.settings;
    this.overlay.render(
      this.overlayCtx,
      this.mapper,
      this.lastPointers,
      {
        showSkeleton: settings.showSkeleton,
        tool: settings.tool,
        color: settings.color,
        brush: this.controls.activeWidth,
        now,
        trace: styleToken('--trace'),
        dim: styleToken('--dim'),
        paper: styleToken('--paper'),
      },
      this.stageWidth,
      this.stageHeight,
    );

    const drawing = this.board.hasActiveStrokes;
    if (drawing !== this.wasDrawing) {
      this.stage.classList.toggle('stage--drawing', drawing);
      this.wasDrawing = drawing;
    }
  }

  /** Repaints the ink layer outside the loop — after a resize, undo or clear. */
  private renderOnce(): void {
    this.board.render(this.inkCtx, this.mapper, this.stageWidth, this.stageHeight);
    this.lastInkVersion = this.board.version;
    if (!this.running) {
      this.overlayCtx.clearRect(0, 0, this.stageWidth, this.stageHeight);
    }
  }

  // ---- actions ----------------------------------------------------------

  private withHistory(action: () => void): void {
    action();
    if (!this.running) this.renderOnce();
  }

  private clear(): void {
    if (this.board.stats.strokes === 0) return;
    this.withHistory(() => this.board.clear());
    this.controls.toast('Board cleared · undo with ⌘Z');
  }

  private async save(mode: ExportMode): Promise<void> {
    if (this.board.stats.strokes === 0) {
      this.controls.toast('Nothing to save yet');
      return;
    }

    try {
      this.board.endAllStrokes();
      const blob = await exportPng({
        actions: this.board.getActions(),
        videoWidth: this.video.videoWidth || this.stageWidth,
        videoHeight: this.video.videoHeight || this.stageHeight,
        mirrored: this.controls.settings.mirror,
        mode,
        video: this.video,
      });
      downloadBlob(blob, timestampedName(mode));
      this.controls.toast(mode === 'ink' ? 'Saved transparent PNG' : 'Saved PNG with camera frame');
    } catch (error) {
      console.error('Export failed', error);
      this.controls.toast('The image could not be saved');
    }
  }

  private onSettingsChange(settings: Settings, key: keyof Settings): void {
    switch (key) {
      case 'mirror':
        // Ink is stored in camera space, so flipping the view re-projects the
        // existing drawing rather than leaving it stranded.
        this.syncMapper();
        this.renderOnce();
        break;
      case 'cameraId':
        if (this.running || this.camera.active) void this.start();
        break;
      case 'gestureMode':
        this.board.endAllStrokes();
        this.pointers.reset();
        break;
      case 'showVideo':
        this.updateMeta();
        break;
      default:
        break;
    }

    if (key === 'smoothing') return;
    void settings;
  }

  private updateMeta(): void {
    const settings = this.camera.settings;
    if (!settings?.width) {
      this.hud.setMeta('');
      return;
    }
    const fps = settings.frameRate ? ` · ${Math.round(settings.frameRate)}fps` : '';
    this.hud.setMeta(`${settings.width} × ${settings.height}${fps} · ${this.tracker.delegate}`);
  }
}

const tokenCache = new Map<string, string>();

/** Reads a CSS custom property once and remembers it — these never change. */
function styleToken(name: string): string {
  const cached = tokenCache.get(name);
  if (cached) return cached;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#fff';
  tokenCache.set(name, value);
  return value;
}
