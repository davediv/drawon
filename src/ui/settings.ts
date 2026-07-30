import { DEFAULT_COLOR, SMOOTHING, STROKE } from '../config';
import type { GestureMode, Tool } from '../types';

export interface Settings {
  tool: Tool;
  color: string;
  penWidth: number;
  eraserWidth: number;
  gestureMode: GestureMode;
  /** 0 = most responsive, 1 = steadiest. */
  smoothing: number;
  mirror: boolean;
  showSkeleton: boolean;
  showVideo: boolean;
  cameraId: string;
}

const STORAGE_KEY = 'drawone.settings.v1';

/** Colours are compared as strings all over the UI, so there is one casing. */
const normaliseColor = (value: unknown): string | null => {
  const text = String(value).toLowerCase();
  return /^#[0-9a-f]{6}$/.test(text) ? text : null;
};

export const defaultSettings: Settings = {
  tool: 'pen',
  color: DEFAULT_COLOR.toLowerCase(),
  penWidth: STROKE.defaultPenWidth,
  eraserWidth: STROKE.defaultEraserWidth,
  gestureMode: 'pinch',
  smoothing: SMOOTHING.default,
  mirror: true,
  showSkeleton: true,
  showVideo: true,
  cameraId: '',
};

const TOOLS: Tool[] = ['pen', 'eraser'];
const MODES: GestureMode[] = ['pinch', 'point', 'grip', 'any'];

const clampWidth = (value: unknown, fallback: number): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), STROKE.minWidth), STROKE.maxWidth);
};

/** Anything unrecognised falls back to the default — stored settings are untrusted. */
export function loadSettings(): Settings {
  let stored: Partial<Settings> = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) stored = JSON.parse(raw) as Partial<Settings>;
  } catch {
    stored = {};
  }

  return {
    tool: TOOLS.includes(stored.tool as Tool) ? (stored.tool as Tool) : defaultSettings.tool,
    color: normaliseColor(stored.color) ?? defaultSettings.color,
    penWidth: clampWidth(stored.penWidth, defaultSettings.penWidth),
    eraserWidth: clampWidth(stored.eraserWidth, defaultSettings.eraserWidth),
    gestureMode: MODES.includes(stored.gestureMode as GestureMode)
      ? (stored.gestureMode as GestureMode)
      : defaultSettings.gestureMode,
    smoothing: Number.isFinite(stored.smoothing)
      ? Math.min(Math.max(Number(stored.smoothing), 0), 1)
      : defaultSettings.smoothing,
    mirror: typeof stored.mirror === 'boolean' ? stored.mirror : defaultSettings.mirror,
    showSkeleton:
      typeof stored.showSkeleton === 'boolean' ? stored.showSkeleton : defaultSettings.showSkeleton,
    showVideo: typeof stored.showVideo === 'boolean' ? stored.showVideo : defaultSettings.showVideo,
    cameraId: typeof stored.cameraId === 'string' ? stored.cameraId : defaultSettings.cameraId,
  };
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private browsing or a full quota — preferences just will not persist.
  }
}
