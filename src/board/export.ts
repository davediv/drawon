import { exportMapper } from '../tracking/frameMapper';
import type { BoardAction } from '../types';
import { paintActions } from './board';

export type ExportMode = 'ink' | 'composite';

export interface ExportRequest {
  actions: readonly BoardAction[];
  videoWidth: number;
  videoHeight: number;
  mirrored: boolean;
  mode: ExportMode;
  /** Required for `composite`, ignored otherwise. */
  video?: HTMLVideoElement | null;
}

/**
 * Renders at the camera's native resolution rather than screenshotting the
 * stage, so the export is independent of window size and of the cropping that
 * object-fit: cover applies. `ink` keeps the alpha channel — the whiteboard
 * really is transparent.
 */
export async function exportPng(request: ExportRequest): Promise<Blob> {
  const { actions, videoWidth, videoHeight, mirrored, mode, video } = request;

  const width = Math.max(videoWidth, 1);
  const height = Math.max(videoHeight, 1);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is unavailable in this browser.');

  if (mode === 'composite' && video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    ctx.save();
    if (mirrored) {
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, width, height);
    ctx.restore();
  }

  const mapper = exportMapper(width, height, mirrored);

  if (mode === 'composite') {
    // Erase actions must not cut a hole through the video frame underneath, so
    // ink is composed on its own layer first and then laid on top.
    const inkLayer = document.createElement('canvas');
    inkLayer.width = width;
    inkLayer.height = height;
    const inkCtx = inkLayer.getContext('2d');
    if (!inkCtx) throw new Error('Canvas 2D is unavailable in this browser.');
    paintActions(inkCtx, actions, mapper, width, height);
    ctx.drawImage(inkLayer, 0, 0);
  } else {
    paintActions(ctx, actions, mapper, width, height);
  }

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The image could not be encoded.'))),
      'image/png',
    );
  });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Give the browser a beat to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function timestampedName(mode: ExportMode): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `drawone-${mode}-${stamp}.png`;
}
