import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from '@mediapipe/tasks-vision';
import { TRACKING } from '../config';

/** Resolve a file in `public/` against however the app happens to be hosted. */
const assetUrl = (path: string): string =>
  new URL(`${import.meta.env.BASE_URL}${path}`, window.location.href).href;

export type Delegate = 'GPU' | 'CPU';

export class HandTracker {
  private landmarker: HandLandmarker | null = null;
  private lastTimestamp = -1;
  delegate: Delegate = 'GPU';

  get ready(): boolean {
    return this.landmarker !== null;
  }

  async load(onProgress?: (message: string) => void): Promise<void> {
    onProgress?.('Loading vision runtime');
    const fileset = await FilesetResolver.forVisionTasks(assetUrl('wasm'));

    const options = {
      baseOptions: {
        modelAssetPath: assetUrl('models/hand_landmarker.task'),
        delegate: 'GPU' as const,
      },
      runningMode: 'VIDEO' as const,
      numHands: TRACKING.numHands,
      minHandDetectionConfidence: TRACKING.minHandDetectionConfidence,
      minHandPresenceConfidence: TRACKING.minHandPresenceConfidence,
      minTrackingConfidence: TRACKING.minTrackingConfidence,
    };

    onProgress?.('Loading hand model');
    try {
      this.landmarker = await HandLandmarker.createFromOptions(fileset, options);
      this.delegate = 'GPU';
    } catch {
      // Some drivers and headless environments have no usable WebGL context.
      // CPU inference is slower but keeps the app working rather than dead.
      onProgress?.('Falling back to CPU inference');
      this.landmarker = await HandLandmarker.createFromOptions(fileset, {
        ...options,
        baseOptions: { ...options.baseOptions, delegate: 'CPU' },
      });
      this.delegate = 'CPU';
    }
  }

  /**
   * @param timestampMs must increase monotonically — MediaPipe rejects a frame
   *        stamped at or before the previous one.
   */
  detect(video: HTMLVideoElement, timestampMs: number): HandLandmarkerResult | null {
    if (!this.landmarker) return null;

    const timestamp = timestampMs <= this.lastTimestamp ? this.lastTimestamp + 1 : timestampMs;
    this.lastTimestamp = timestamp;

    try {
      return this.landmarker.detectForVideo(video, timestamp);
    } catch {
      return null;
    }
  }

  close(): void {
    this.landmarker?.close();
    this.landmarker = null;
    this.lastTimestamp = -1;
  }
}
