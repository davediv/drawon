"""Hex colours to the BGR triples OpenCV wants."""

from __future__ import annotations

from typing import Dict, Tuple

from ..lib.maths import clamp01

Bgr = Tuple[int, int, int]

_cache: Dict[str, Bgr] = {}

WHITE: Bgr = (255, 255, 255)


def to_bgr(value: str) -> Bgr:
    """`#rgb` or `#rrggbb` to (b, g, r). Anything unparseable comes back white."""
    cached = _cache.get(value)
    if cached is not None:
        return cached

    text = value.strip().lstrip("#")
    if len(text) == 3:
        text = "".join(c * 2 for c in text)

    try:
        packed = int(text, 16)
        rgb: Bgr = ((packed >> 16) & 255, (packed >> 8) & 255, packed & 255)
        bgr = (rgb[2], rgb[1], rgb[0])
    except ValueError:
        bgr = WHITE

    _cache[value] = bgr
    return bgr


def to_hex(bgr: Bgr) -> str:
    b, g, r = bgr
    return "#{:02x}{:02x}{:02x}".format(r, g, b)


def luminance(value: str) -> float:
    """Relative luminance, used to decide whether a swatch needs a dark tick."""
    b, g, r = to_bgr(value)

    def channel(v: int) -> float:
        s = v / 255.0
        return s / 12.92 if s <= 0.03928 else ((s + 0.055) / 1.055) ** 2.4

    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)


def mix(a: Bgr, b: Bgr, t: float) -> Bgr:
    t = clamp01(t)
    return (
        int(round(a[0] + (b[0] - a[0]) * t)),
        int(round(a[1] + (b[1] - a[1]) * t)),
        int(round(a[2] + (b[2] - a[2]) * t)),
    )
