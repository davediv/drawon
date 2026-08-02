"""The drawing: a list of vector actions plus a rasterised cache of the finished ones."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable, Dict, Iterable, List, Optional, Sequence

from ..config import STROKE
from ..render.canvas import Layer, Point, flatten_quadratic, stroke_polyline
from ..render.color import to_bgr
from ..tracking.frame_mapper import FrameMapper
from ..types import BoardAction, BoardPoint, ClearAction, StrokeAction, Tool


def build_path(stroke: StrokeAction, mapper: FrameMapper) -> List[Point]:
    """Traces a stroke as a chain of quadratic curves whose control points are
    the samples and whose endpoints are the midpoints between them.

    Two things fall out of that: the curve is C1 continuous, so the line reads as
    one gesture rather than a polyline, and widely spaced samples during a fast
    movement are bridged by a curve instead of leaving a gap.
    """
    pts = [mapper.board_to_stage(p.x, p.y) for p in stroke.points]
    n = len(pts)

    if n == 1:
        return [(pts[0].x, pts[0].y)]
    if n == 2:
        return [(pts[0].x, pts[0].y), (pts[1].x, pts[1].y)]

    path: List[Point] = [(pts[0].x, pts[0].y)]
    current = pts[1]
    for i in range(1, n - 1):
        following = pts[i + 1]
        midpoint = (
            (current.x + following.x) / 2,
            (current.y + following.y) / 2,
        )
        flatten_quadratic(path[-1], (current.x, current.y), midpoint, path)
        current = following
    path.append((current.x, current.y))
    return path


def paint_stroke(layer: Layer, stroke: StrokeAction, mapper: FrameMapper) -> None:
    width = max(stroke.width * mapper.pixels_per_unit, 0.6)
    stroke_polyline(
        layer,
        build_path(stroke, mapper),
        width,
        to_bgr(stroke.color),
        erase=stroke.tool == "eraser",
    )


def paint_actions(
    layer: Layer, actions: Sequence[BoardAction], mapper: FrameMapper
) -> None:
    layer.clear()
    for action in actions:
        if isinstance(action, ClearAction):
            layer.clear()
        else:
            paint_stroke(layer, action, mapper)


@dataclass(frozen=True)
class BoardStats:
    strokes: int
    can_undo: bool
    can_redo: bool


class Board:
    """Holds the drawing as a list of vector actions and keeps a rasterised cache
    of the finished ones.

    Finished strokes are painted into the cache exactly once; only in-progress
    strokes are re-traced each frame. Undo, redo, clear and window resizes replay
    the action list, which is also what makes undo work across an erase or a
    clear.
    """

    def __init__(self) -> None:
        self._actions: List[BoardAction] = []
        self._redo: List[BoardAction] = []
        self._active: Dict[int, StrokeAction] = {}

        self._cache = Layer(1, 1)
        self._scratch = Layer(1, 1)
        self._cache_stale = True
        #: The mapper the cache was rasterised with; None until the first render.
        self._cache_mapper: Optional[FrameMapper] = None

        #: Bumped whenever the visible result would differ.
        self.version = 0
        self.on_change: Optional[Callable[[BoardStats], None]] = None

    @property
    def stats(self) -> BoardStats:
        """`strokes` counts what is currently *visible*, not everything ever
        drawn — a clear resets it to zero. Clear and Save key off this, and both
        should be dead on an empty board even though the history behind it is
        still intact.
        """
        visible = 0
        for action in self._actions:
            if isinstance(action, ClearAction):
                visible = 0
            else:
                visible += 1
        return BoardStats(
            strokes=visible,
            can_undo=len(self._actions) > 0,
            can_redo=len(self._redo) > 0,
        )

    @property
    def active_strokes(self) -> Iterable[StrokeAction]:
        return list(self._active.values())

    @property
    def has_active_strokes(self) -> bool:
        return len(self._active) > 0

    def has_active_stroke(self, hand_id: int) -> bool:
        return hand_id in self._active

    def get_actions(self) -> Sequence[BoardAction]:
        return self._actions

    def resize(self, width: int, height: int) -> None:
        if not self._cache.resize(width, height):
            return
        self._scratch.resize(width, height)
        self._cache_stale = True
        self.version += 1

    # ---- stroke lifecycle -------------------------------------------------

    def begin_stroke(
        self, hand_id: int, tool: Tool, color: str, width: float, at: BoardPoint
    ) -> None:
        self._active[hand_id] = StrokeAction(
            tool=tool, color=color, width=width, points=[at]
        )
        self.version += 1

    def extend_stroke(self, hand_id: int, at: BoardPoint) -> bool:
        """Returns False when the sample was rejected, which ends the stroke."""
        stroke = self._active.get(hand_id)
        if stroke is None:
            return False

        last = stroke.points[-1]
        distance = math.hypot(at.x - last.x, at.y - last.y)

        if distance > STROKE.max_jump_distance:
            return False
        if distance < STROKE.min_point_distance:
            return True

        stroke.points.append(at)
        self.version += 1
        return True

    def end_stroke(self, hand_id: int) -> None:
        stroke = self._active.pop(hand_id, None)
        if stroke is None:
            return
        self._push_action(stroke)

    def cancel_stroke(self, hand_id: int) -> None:
        if self._active.pop(hand_id, None) is not None:
            self.version += 1

    def end_all_strokes(self) -> None:
        for hand_id in list(self._active.keys()):
            self.end_stroke(hand_id)

    # ---- history ----------------------------------------------------------

    def clear(self) -> None:
        self.end_all_strokes()
        # Nothing on screen means nothing to clear — do not stack redundant clears.
        if self.stats.strokes == 0:
            return
        # Recorded as an action so that clearing is undoable like anything else.
        self._push_action(ClearAction())

    def undo(self) -> None:
        self.end_all_strokes()
        if not self._actions:
            return
        self._redo.append(self._actions.pop())
        self._cache_stale = True
        self.version += 1
        self._notify()

    def redo(self) -> None:
        if not self._redo:
            return
        action = self._redo.pop()
        self._actions.append(action)
        self._apply_to_cache(action)
        self.version += 1
        self._notify()

    def _push_action(self, action: BoardAction) -> None:
        self._actions.append(action)
        self._redo.clear()
        self._apply_to_cache(action)
        self.version += 1
        self._notify()

    def _apply_to_cache(self, action: BoardAction) -> None:
        """Appending never needs a replay — only removal does."""
        if self._cache_stale:
            return
        if self._cache_mapper is None:
            self._cache_stale = True
            return
        if isinstance(action, ClearAction):
            self._cache.clear()
        else:
            paint_stroke(self._cache, action, self._cache_mapper)

    def _notify(self) -> None:
        if self.on_change is not None:
            self.on_change(self.stats)

    # ---- rendering --------------------------------------------------------

    def render(self, mapper: FrameMapper, width: int, height: int) -> Layer:
        """Returns the layer to composite: finished ink plus any live strokes.

        With nothing in progress this is the cache itself, so a settled drawing
        costs no per-frame raster work at all.
        """
        self.resize(width, height)
        self._cache_mapper = mapper

        if self._cache_stale:
            paint_actions(self._cache, self._actions, mapper)
            self._cache_stale = False

        if not self._active:
            return self._cache

        self._scratch.copy_from(self._cache)
        for stroke in self._active.values():
            paint_stroke(self._scratch, stroke, mapper)
        return self._scratch

    def invalidate(self) -> None:
        """Forces a replay on the next render — after a resize or a mapper change."""
        self._cache_stale = True
        self.version += 1
