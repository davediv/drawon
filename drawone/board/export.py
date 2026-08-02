"""PNG export.

Renders at the camera's native resolution rather than screenshotting the window,
so the export is independent of window size and of the cropping that cover-fit
applies. `ink` keeps the alpha channel — the whiteboard really is transparent.
"""

from __future__ import annotations

import datetime as _datetime
from pathlib import Path
from typing import Literal, Optional, Sequence

import cv2
import numpy as np

from ..render.canvas import Layer, composite_over, to_straight_bgra
from ..tracking.frame_mapper import export_mapper
from ..types import BoardAction
from .board import paint_actions

ExportMode = Literal["ink", "composite"]


def render_export(
    actions: Sequence[BoardAction],
    video_width: int,
    video_height: int,
    mirrored: bool,
    mode: ExportMode,
    frame: Optional[np.ndarray] = None,
) -> np.ndarray:
    """The finished image: BGRA for `ink`, BGR for `composite`."""
    width = max(int(video_width), 1)
    height = max(int(video_height), 1)

    layer = Layer(width, height)
    paint_actions(layer, actions, export_mapper(width, height, mirrored))

    if mode != "composite":
        return to_straight_bgra(layer)

    if frame is None:
        base = np.zeros((height, width, 3), np.uint8)
    else:
        base = frame
        if base.shape[0] != height or base.shape[1] != width:
            base = cv2.resize(base, (width, height), interpolation=cv2.INTER_AREA)
        if mirrored:
            base = cv2.flip(base, 1)
        base = np.ascontiguousarray(base)

    # Ink lives on its own layer, so an erase cuts holes in the drawing rather
    # than through the camera frame underneath.
    composite_over(base, layer)
    return base


def export_png(
    path: Path,
    actions: Sequence[BoardAction],
    video_width: int,
    video_height: int,
    mirrored: bool,
    mode: ExportMode,
    frame: Optional[np.ndarray] = None,
) -> Path:
    image = render_export(actions, video_width, video_height, mirrored, mode, frame)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(path), image):
        raise OSError("The image could not be encoded: {}".format(path))
    return path


def timestamped_name(mode: ExportMode) -> str:
    stamp = _datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    return "drawone-{}-{}.png".format(mode, stamp)
