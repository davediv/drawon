import { clamp01 } from '../lib/math';

interface Rgb {
  r: number;
  g: number;
  b: number;
}

const cache = new Map<string, Rgb>();

export function parseHex(hex: string): Rgb {
  const cached = cache.get(hex);
  if (cached) return cached;

  let value = hex.trim().replace('#', '');
  if (value.length === 3) {
    value = value
      .split('')
      .map((c) => c + c)
      .join('');
  }

  const int = Number.parseInt(value, 16);
  const rgb: Rgb = Number.isNaN(int)
    ? { r: 255, g: 255, b: 255 }
    : { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };

  cache.set(hex, rgb);
  return rgb;
}

export function withAlpha(hex: string, alpha: number): string {
  const { r, g, b } = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${clamp01(alpha).toFixed(3)})`;
}

/** Relative luminance, used to decide whether a swatch needs a dark checkmark. */
export function luminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
