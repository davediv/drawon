"""Small maths helpers used by the gesture, mapping and render layers."""

from __future__ import annotations

import math
from typing import Optional

from ..types import Vec2, Vec3


def clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else hi if v > hi else v


def clamp01(v: float) -> float:
    return clamp(v, 0.0, 1.0)


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def inv_lerp(a: float, b: float, v: float) -> float:
    """Where does `v` sit between `a` and `b`, clamped to 0..1?

    Works when a > b, which is how the gesture scores invert "smaller is
    better" measurements such as pinch distance.
    """
    if a == b:
        return 1.0 if v >= b else 0.0
    return clamp01((v - a) / (b - a))


def smooth_ramp(a: float, b: float, v: float) -> float:
    """inv_lerp with a smooth (C1) ramp — avoids visible stepping in the nib arc."""
    t = inv_lerp(a, b, v)
    return t * t * (3 - 2 * t)


def dist2(a: Vec2, b: Vec2) -> float:
    return math.hypot(b.x - a.x, b.y - a.y)


def dist3(a: Vec3, b: Vec3) -> float:
    return math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)


def angle_at(vertex: Vec3, a: Vec3, b: Vec3) -> float:
    """Interior angle at `vertex` in degrees, in 3D.

    180 = perfectly straight joint, 0 = fully folded back on itself.
    """
    ax = a.x - vertex.x
    ay = a.y - vertex.y
    az = a.z - vertex.z
    bx = b.x - vertex.x
    by = b.y - vertex.y
    bz = b.z - vertex.z

    la = math.hypot(ax, ay, az)
    lb = math.hypot(bx, by, bz)
    if la < 1e-9 or lb < 1e-9:
        return 180.0

    cos = clamp((ax * bx + ay * by + az * bz) / (la * lb), -1.0, 1.0)
    return math.degrees(math.acos(cos))


class Ema:
    """Exponential moving average, framerate-agnostic enough for HUD counters."""

    def __init__(self, alpha: float) -> None:
        self._alpha = alpha
        self._value: Optional[float] = None

    def push(self, sample: float) -> float:
        self._value = (
            sample
            if self._value is None
            else self._alpha * sample + (1 - self._alpha) * self._value
        )
        return self._value

    @property
    def current(self) -> float:
        return self._value if self._value is not None else 0.0

    def reset(self) -> None:
        self._value = None
