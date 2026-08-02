"""Drawing primitives for the interface.

The web build had CSS; here the housing is painted straight onto the frame.
Same intent though: dark blue-graphite panels that never glare against live
video, hairline rules, and monospace readouts.
"""

from __future__ import annotations

from typing import Optional, Tuple

import cv2
import numpy as np

from ..config import THEME
from ..render.color import Bgr, mix, to_bgr

LABEL = cv2.FONT_HERSHEY_DUPLEX
MONO = cv2.FONT_HERSHEY_PLAIN

Rect = Tuple[int, int, int, int]


class Palette:
    """Theme colours, parsed once."""

    void: Bgr = to_bgr(THEME["void"])
    case: Bgr = to_bgr(THEME["case"])
    case2: Bgr = to_bgr(THEME["case2"])
    rule: Bgr = to_bgr(THEME["rule"])
    rule2: Bgr = to_bgr(THEME["rule2"])
    paper: Bgr = to_bgr(THEME["paper"])
    dim: Bgr = to_bgr(THEME["dim"])
    dim2: Bgr = to_bgr(THEME["dim2"])
    signal: Bgr = to_bgr(THEME["signal"])
    trace: Bgr = to_bgr(THEME["trace"])


def clip_rect(image: np.ndarray, rect: Rect) -> Optional[Rect]:
    height, width = image.shape[:2]
    x0 = max(0, min(int(rect[0]), width))
    y0 = max(0, min(int(rect[1]), height))
    x1 = max(0, min(int(rect[2]), width))
    y1 = max(0, min(int(rect[3]), height))
    if x1 <= x0 or y1 <= y0:
        return None
    return (x0, y0, x1, y1)


def panel(
    image: np.ndarray,
    rect: Rect,
    color: Bgr = Palette.case,
    alpha: float = 0.86,
    border: Optional[Bgr] = None,
) -> None:
    clipped = clip_rect(image, rect)
    if clipped is None:
        return
    x0, y0, x1, y1 = clipped
    roi = image[y0:y1, x0:x1]
    if alpha >= 1.0:
        roi[:] = color
    else:
        fill = np.empty_like(roi)
        fill[:] = color
        cv2.addWeighted(roi, 1.0 - alpha, fill, alpha, 0.0, roi)
    if border is not None:
        cv2.rectangle(image, (x0, y0), (x1 - 1, y1 - 1), border, 1, cv2.LINE_8)


def outline(image: np.ndarray, rect: Rect, color: Bgr) -> None:
    clipped = clip_rect(image, rect)
    if clipped is None:
        return
    x0, y0, x1, y1 = clipped
    cv2.rectangle(image, (x0, y0), (x1 - 1, y1 - 1), color, 1, cv2.LINE_8)


def rule(image: np.ndarray, x0: int, y: int, x1: int, color: Bgr = Palette.rule) -> None:
    cv2.line(image, (int(x0), int(y)), (int(x1), int(y)), color, 1, cv2.LINE_8)


def text_size(
    value: str, size: float, weight: int = 1, font: int = LABEL
) -> Tuple[int, int]:
    (width, height), _ = cv2.getTextSize(value, font, size, weight)
    return width, height


def text(
    image: np.ndarray,
    value: str,
    x: float,
    y: float,
    color: Bgr = Palette.paper,
    size: float = 0.4,
    weight: int = 1,
    font: int = LABEL,
    align: str = "left",
) -> int:
    """Draws `value` with its top-left (or top-centre/right) at (x, y).

    Returns the advance width, so callers can lay a row out left to right.
    """
    width, height = text_size(value, size, weight, font)
    if align == "center":
        x -= width / 2
    elif align == "right":
        x -= width
    cv2.putText(
        image,
        value,
        (int(round(x)), int(round(y + height))),
        font,
        size,
        color,
        weight,
        cv2.LINE_AA,
    )
    return width


def chip(
    image: np.ndarray,
    label: str,
    rect: Rect,
    *,
    active: bool = False,
    enabled: bool = True,
    size: float = 0.4,
    accent: Bgr = Palette.trace,
) -> None:
    """A dock button: filled and lit when active, hairline and dim otherwise."""
    x0, y0, x1, y1 = rect
    if active:
        panel(image, rect, mix(Palette.case2, accent, 0.22), 0.95, border=accent)
        color = Palette.paper
    else:
        panel(image, rect, Palette.case2, 0.7, border=Palette.rule)
        color = Palette.dim if enabled else Palette.dim2
    text(image, label, (x0 + x1) / 2, (y0 + y1) / 2 - 5, color, size, 1, LABEL, "center")


def meter(
    image: np.ndarray,
    rect: Rect,
    fraction: float,
    color: Bgr = Palette.trace,
    track: Bgr = Palette.rule,
) -> None:
    x0, y0, x1, y1 = rect
    panel(image, rect, track, 0.9)
    filled = int(round((x1 - x0) * max(0.0, min(1.0, fraction))))
    if filled > 0:
        panel(image, (x0, y0, x0 + filled, y1), color, 1.0)
