import { BOARD_HEIGHT } from '../config';
import type { Vec2 } from '../types';

/**
 * Converts between the three coordinate spaces in play:
 *
 *  normalized  — what MediaPipe returns, 0..1 across the camera frame
 *  board       — where strokes are stored: isotropic, y spans 0..1000 over the
 *                camera frame height, x spans 0..1000*aspect
 *  stage       — CSS pixels on screen, after object-fit: cover and mirroring
 *
 * Strokes are stored in board space rather than pixels so that resizing the
 * window re-projects the artwork instead of stretching or discarding it, and so
 * that a PNG can be exported at the camera's native resolution.
 */
export class FrameMapper {
  videoWidth = 0;
  videoHeight = 0;
  stageWidth = 0;
  stageHeight = 0;
  mirrored = true;

  /** Stage pixels per board unit. */
  private k = 1;
  private originX = 0;
  private originY = 0;

  get ready(): boolean {
    return this.videoWidth > 0 && this.videoHeight > 0 && this.stageWidth > 0;
  }

  /** Board-space width of the visible frame (height is always BOARD_HEIGHT). */
  get boardWidth(): number {
    return this.videoHeight > 0 ? (this.videoWidth / this.videoHeight) * BOARD_HEIGHT : BOARD_HEIGHT;
  }

  /** Stage pixels per board unit — use it to convert stroke widths. */
  get pixelsPerUnit(): number {
    return this.k;
  }

  configure(
    videoWidth: number,
    videoHeight: number,
    stageWidth: number,
    stageHeight: number,
    mirrored: boolean,
  ): void {
    this.videoWidth = videoWidth;
    this.videoHeight = videoHeight;
    this.stageWidth = stageWidth;
    this.stageHeight = stageHeight;
    this.mirrored = mirrored;

    if (!this.ready) {
      this.k = 1;
      this.originX = 0;
      this.originY = 0;
      return;
    }

    // object-fit: cover — scale so the frame fills the stage, overflow is cropped.
    const scale = Math.max(stageWidth / videoWidth, stageHeight / videoHeight);
    const displayWidth = videoWidth * scale;
    const displayHeight = videoHeight * scale;

    this.k = displayHeight / BOARD_HEIGHT;
    this.originX = (stageWidth - displayWidth) / 2;
    this.originY = (stageHeight - displayHeight) / 2;
  }

  /** Normalized MediaPipe coordinates to board space. */
  normalizedToBoard(nx: number, ny: number): Vec2 {
    return { x: nx * this.boardWidth, y: ny * BOARD_HEIGHT };
  }

  boardToStage(bx: number, by: number): Vec2 {
    const x = this.originX + bx * this.k;
    return {
      x: this.mirrored ? this.stageWidth - x : x,
      y: this.originY + by * this.k,
    };
  }

  normalizedToStage(nx: number, ny: number): Vec2 {
    const b = this.normalizedToBoard(nx, ny);
    return this.boardToStage(b.x, b.y);
  }
}

/**
 * A mapper that renders board space 1:1 into a bitmap of the given size —
 * used for PNG export, where there is no cropping and no stage.
 */
export function exportMapper(
  videoWidth: number,
  videoHeight: number,
  mirrored: boolean,
): FrameMapper {
  const mapper = new FrameMapper();
  mapper.configure(videoWidth, videoHeight, videoWidth, videoHeight, mirrored);
  return mapper;
}
