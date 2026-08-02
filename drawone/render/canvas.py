"""A small 2D canvas over NumPy, standing in for the browser's 2D context.

Layers are BGRA with **premultiplied** colour. That choice does most of the work
here: OpenCV's antialiasing blends every channel toward the target value, which
is exactly source-over compositing when the source is premultiplied — so edges
stay the right colour instead of darkening against transparency. Compositing a
layer onto the video frame is then one multiply and one add, and export only has
to undo the premultiplication once.

Each layer also tracks the bounding box of everything drawn into it, so
compositing and clearing touch just that region rather than the whole frame.
"""

from __future__ import annotations

import math
from typing import Iterable, List, Optional, Sequence, Tuple

import cv2
import numpy as np

from ..lib.maths import clamp01
from .color import Bgr

#: Fractional bits handed to OpenCV's drawing calls. Subpixel positioning is
#: what keeps slow strokes from stair-stepping.
SHIFT = 4
SCALE = 1 << SHIFT

Point = Tuple[float, float]
Box = Tuple[int, int, int, int]


def _fp(x: float, y: float) -> Tuple[int, int]:
    return (int(round(x * SCALE)), int(round(y * SCALE)))


def _fr(v: float) -> int:
    return int(round(v * SCALE))


def _premultiplied(bgr: Bgr, alpha: float) -> Tuple[int, int, int, int]:
    a = clamp01(alpha)
    return (
        int(round(bgr[0] * a)),
        int(round(bgr[1] * a)),
        int(round(bgr[2] * a)),
        int(round(255 * a)),
    )


class Layer:
    """A premultiplied BGRA raster with a dirty box."""

    def __init__(self, width: int, height: int) -> None:
        self.data = np.zeros((max(height, 1), max(width, 1), 4), np.uint8)
        self._box: Optional[Box] = None
        self._planes: Optional[Tuple[np.ndarray, np.ndarray]] = None

    @property
    def width(self) -> int:
        return int(self.data.shape[1])

    @property
    def height(self) -> int:
        return int(self.data.shape[0])

    @property
    def box(self) -> Optional[Box]:
        """Bounds of everything drawn since the last clear, or None if empty."""
        return self._box

    def resize(self, width: int, height: int) -> bool:
        width = max(int(width), 1)
        height = max(int(height), 1)
        if width == self.width and height == self.height:
            return False
        self.data = np.zeros((height, width, 4), np.uint8)
        self._box = None
        self._planes = None
        return True

    def mark(self, x0: float, y0: float, x1: float, y1: float) -> None:
        """Records that pixels in this rectangle may have changed."""
        self._planes = None
        cx0 = max(0, int(math.floor(x0)))
        cy0 = max(0, int(math.floor(y0)))
        cx1 = min(self.width, int(math.ceil(x1)))
        cy1 = min(self.height, int(math.ceil(y1)))
        if cx1 <= cx0 or cy1 <= cy0:
            return
        if self._box is None:
            self._box = (cx0, cy0, cx1, cy1)
        else:
            bx0, by0, bx1, by1 = self._box
            self._box = (min(bx0, cx0), min(by0, cy0), max(bx1, cx1), max(by1, cy1))

    def touch(self) -> None:
        """Invalidates the composite cache without growing the box."""
        self._planes = None

    def clear(self) -> None:
        if self._box is not None:
            x0, y0, x1, y1 = self._box
            self.data[y0:y1, x0:x1] = 0
        self._box = None
        self._planes = None

    def copy_from(self, other: "Layer") -> None:
        """Reuses this layer's buffer to mirror another of the same size."""
        if self.data.shape != other.data.shape:
            self.data = other.data.copy()
        else:
            box = _union(self._box, other._box)
            if box is None:
                self._box = None
                self._planes = None
                return
            x0, y0, x1, y1 = box
            self.data[y0:y1, x0:x1] = other.data[y0:y1, x0:x1]
        self._box = other._box
        self._planes = None

    def _composite_planes(self) -> Optional[Tuple[np.ndarray, np.ndarray]]:
        """Colour and inverse-alpha planes for the dirty box, cached.

        A finished drawing does not change between frames, so this is computed
        once and reused until something is drawn again.
        """
        if self._box is None:
            return None
        if self._planes is None:
            x0, y0, x1, y1 = self._box
            b, g, r, a = cv2.split(self.data[y0:y1, x0:x1])
            inverse = cv2.bitwise_not(a)
            self._planes = (cv2.merge((b, g, r)), cv2.merge((inverse, inverse, inverse)))
        return self._planes


def _union(a: Optional[Box], b: Optional[Box]) -> Optional[Box]:
    if a is None:
        return b
    if b is None:
        return a
    return (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))


def composite_over(dst_bgr: np.ndarray, layer: Layer) -> np.ndarray:
    """Lays a premultiplied layer over an opaque BGR image, in place."""
    planes = layer._composite_planes()
    if planes is None or layer.box is None:
        return dst_bgr
    color, inverse = planes
    x0, y0, x1, y1 = layer.box
    roi = dst_bgr[y0:y1, x0:x1]
    roi[:] = cv2.add(cv2.multiply(roi, inverse, scale=1.0 / 255.0), color)
    return dst_bgr


def to_straight_bgra(layer: Layer) -> np.ndarray:
    """Undoes the premultiplication, giving the BGRA a PNG encoder expects."""
    data = layer.data
    alpha = data[:, :, 3].astype(np.float32)
    scale = np.where(alpha > 0, 255.0 / np.maximum(alpha, 1.0), 0.0)
    out = np.empty_like(data)
    out[:, :, 3] = data[:, :, 3]
    color = data[:, :, :3].astype(np.float32) * scale[..., None]
    np.clip(color, 0, 255, out=color)
    out[:, :, :3] = color.astype(np.uint8)
    return out


# ---- primitives -----------------------------------------------------------


def line(
    layer: Layer,
    p0: Point,
    p1: Point,
    bgr: Bgr,
    alpha: float = 1.0,
    width: float = 1.0,
) -> None:
    thickness = max(1, int(round(width)))
    cv2.line(
        layer.data,
        _fp(*p0),
        _fp(*p1),
        _premultiplied(bgr, alpha),
        thickness,
        cv2.LINE_AA,
        SHIFT,
    )
    pad = thickness / 2 + 1
    layer.mark(
        min(p0[0], p1[0]) - pad,
        min(p0[1], p1[1]) - pad,
        max(p0[0], p1[0]) + pad,
        max(p0[1], p1[1]) + pad,
    )


def lines(
    layer: Layer,
    segments: Iterable[Tuple[Point, Point]],
    bgr: Bgr,
    alpha: float = 1.0,
    width: float = 1.0,
) -> None:
    for p0, p1 in segments:
        line(layer, p0, p1, bgr, alpha, width)


def circle(
    layer: Layer,
    center: Point,
    radius: float,
    bgr: Bgr,
    alpha: float = 1.0,
    width: float = 1.0,
    fill: bool = False,
) -> None:
    thickness = -1 if fill else max(1, int(round(width)))
    cv2.circle(
        layer.data,
        _fp(*center),
        _fr(max(radius, 0.1)),
        _premultiplied(bgr, alpha),
        thickness,
        cv2.LINE_AA,
        SHIFT,
    )
    pad = radius + (1 if fill else thickness / 2 + 1)
    layer.mark(center[0] - pad, center[1] - pad, center[0] + pad, center[1] + pad)


def arc(
    layer: Layer,
    center: Point,
    radius: float,
    start_deg: float,
    end_deg: float,
    bgr: Bgr,
    alpha: float = 1.0,
    width: float = 1.0,
) -> None:
    thickness = max(1, int(round(width)))
    cv2.ellipse(
        layer.data,
        _fp(*center),
        (_fr(max(radius, 0.1)), _fr(max(radius, 0.1))),
        0.0,
        start_deg,
        end_deg,
        _premultiplied(bgr, alpha),
        thickness,
        cv2.LINE_AA,
        SHIFT,
    )
    pad = radius + thickness / 2 + 1
    layer.mark(center[0] - pad, center[1] - pad, center[0] + pad, center[1] + pad)


def dashed_circle(
    layer: Layer,
    center: Point,
    radius: float,
    bgr: Bgr,
    alpha: float = 1.0,
    width: float = 1.0,
    dash: float = 3.0,
    gap: float = 4.0,
) -> None:
    """Stands in for canvas `setLineDash` on a circular path."""
    circumference = 2 * math.pi * max(radius, 0.5)
    period = max(dash + gap, 1.0)
    steps = max(int(circumference / period), 4)
    span = 360.0 / steps
    on = span * (dash / period)
    for i in range(steps):
        start = i * span
        arc(layer, center, radius, start, start + on, bgr, alpha, width)


def stroke_polyline(
    layer: Layer,
    points: Sequence[Point],
    width: float,
    bgr: Bgr,
    erase: bool = False,
) -> None:
    """Paints one ink stroke.

    The path is rasterised into a coverage mask first and composited in a single
    pass. Stamping segment by segment would blend every overlap twice and leave
    a visibly darker seam down a stroke that doubles back on itself; erasing
    needs the coverage as a mask anyway, since it removes ink rather than
    painting over it.
    """
    if not points:
        return

    thickness = max(width, 0.6)
    radius = thickness / 2
    pad = radius + 2

    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    x0 = max(0, int(math.floor(min(xs) - pad)))
    y0 = max(0, int(math.floor(min(ys) - pad)))
    x1 = min(layer.width, int(math.ceil(max(xs) + pad)))
    y1 = min(layer.height, int(math.ceil(max(ys) + pad)))
    if x1 <= x0 or y1 <= y0:
        return

    mask = np.zeros((y1 - y0, x1 - x0), np.uint8)
    local = [(p[0] - x0, p[1] - y0) for p in points]

    if len(local) == 1:
        cv2.circle(mask, _fp(*local[0]), _fr(radius), 255, -1, cv2.LINE_AA, SHIFT)
    else:
        pts = np.array([_fp(x, y) for x, y in local], np.int32).reshape(-1, 1, 2)
        stroke_width = max(1, int(round(thickness)))
        cv2.polylines(mask, [pts], False, 255, stroke_width, cv2.LINE_AA, SHIFT)
        # OpenCV rounds joins and the trailing end of a thick polyline but leaves
        # the leading end flat, so the opening cap is stamped by hand.
        if stroke_width > 1:
            cv2.circle(mask, _fp(*local[0]), _fr(radius), 255, -1, cv2.LINE_AA, SHIFT)

    _composite_mask(layer, mask, (x0, y0, x1, y1), bgr, erase)


def _composite_mask(
    layer: Layer, mask: np.ndarray, box: Box, bgr: Bgr, erase: bool
) -> None:
    x0, y0, x1, y1 = box
    region = layer.data[y0:y1, x0:x1]

    coverage = mask.astype(np.float32) * (1.0 / 255.0)
    out = region.astype(np.float32)
    out *= (1.0 - coverage)[..., None]

    if erase:
        # destination-out: cut a real hole in the ink instead of painting the
        # background over it, which is what keeps the board transparent.
        layer.touch()
    else:
        out[..., 0] += bgr[0] * coverage
        out[..., 1] += bgr[1] * coverage
        out[..., 2] += bgr[2] * coverage
        out[..., 3] += 255.0 * coverage
        layer.mark(x0, y0, x1, y1)

    np.rint(out, out=out)
    np.clip(out, 0, 255, out=out)
    region[:] = out.astype(np.uint8)


def flatten_quadratic(
    p0: Point, control: Point, p1: Point, out: List[Point], tolerance: float = 0.25
) -> None:
    """Appends a quadratic Bézier to `out` as line segments (excluding `p0`).

    OpenCV has no curve primitive, so curves are flattened here. The segment
    count follows the control polygon's length, which keeps long sweeping curves
    smooth without spending hundreds of points on a two-pixel wiggle.
    """
    span = math.hypot(control[0] - p0[0], control[1] - p0[1]) + math.hypot(
        p1[0] - control[0], p1[1] - control[1]
    )
    steps = int(min(max(math.ceil(math.sqrt(span / max(tolerance, 0.05))), 1), 24))
    for i in range(1, steps + 1):
        t = i / steps
        u = 1.0 - t
        a = u * u
        b = 2 * u * t
        c = t * t
        out.append(
            (
                a * p0[0] + b * control[0] + c * p1[0],
                a * p0[1] + b * control[1] + c * p1[1],
            )
        )
