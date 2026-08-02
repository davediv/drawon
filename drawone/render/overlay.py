"""Everything that is not ink: the tracked hand skeleton and the nib.

The nib is deliberately more than a dot. Air-drawing has no physical feedback, so
the cursor has to answer three questions at a glance: where the pen is, how thick
the line will be (the ring is the true stroke width), and how close the gesture is
to engaging (the arc). Without that last one, a gesture that nearly fires just
feels broken.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Dict, Sequence

from ..config import THEME
from ..lib.maths import clamp01, lerp
from ..tracking.frame_mapper import FrameMapper
from ..tracking.landmarks import FINGER_BONES, LM, PALM_BONES
from ..tracking.pointers import HandPointer
from ..types import Tool
from . import canvas
from .canvas import Layer, Point
from .color import Bgr, to_bgr

CHARGE_MS = 170.0
OTHER_FINGERS = ("thumb", "middle", "ring", "pinky")


@dataclass(frozen=True)
class OverlayOptions:
    show_skeleton: bool
    tool: Tool
    color: str
    #: Current brush size in board units.
    brush: float
    #: Monotonic milliseconds, for time-based cues.
    now: float
    trace: str = THEME["trace"]
    dim: str = THEME["dim"]
    paper: str = THEME["paper"]


class OverlayRenderer:
    def __init__(self) -> None:
        self._charges: Dict[int, float] = {}

    def render(
        self,
        layer: Layer,
        mapper: FrameMapper,
        pointers: Sequence[HandPointer],
        options: OverlayOptions,
    ) -> None:
        layer.clear()
        if not mapper.ready:
            return

        for pointer in pointers:
            if pointer.just_pressed:
                self._charges[pointer.id] = options.now
            if options.show_skeleton:
                self._draw_skeleton(layer, mapper, pointer, options)
            if not pointer.is_down:
                self._draw_trail(layer, mapper, pointer, options)

        # Nibs last so they sit above every skeleton when hands overlap.
        for pointer in pointers:
            self._draw_nib(layer, mapper, pointer, options)

    def _draw_skeleton(
        self,
        layer: Layer,
        mapper: FrameMapper,
        pointer: HandPointer,
        options: OverlayOptions,
    ) -> None:
        landmarks = pointer.landmarks

        def project(index: int) -> Point:
            lm = landmarks[index]
            p = mapper.normalized_to_stage(lm.x, lm.y)
            return (p.x, p.y)

        # Step back while drawing so the skeleton never competes with the stroke.
        fade = 0.45 if pointer.is_down else 1.0
        trace = to_bgr(options.trace)

        def bones(pairs, alpha: float, width: float) -> None:
            for a, b in pairs:
                canvas.line(layer, project(a), project(b), trace, alpha * fade, width)

        bones(PALM_BONES, 0.28, 1.25)
        for finger in OTHER_FINGERS:
            bones(FINGER_BONES[finger], 0.28, 1.25)
        # The index chain is the one that matters — it carries the nib.
        bones(FINGER_BONES["index"], 0.85, 1.75)

        for i in range(len(landmarks)):
            if i == LM.INDEX_TIP:
                continue
            canvas.circle(layer, project(i), 1.9, trace, 0.5 * fade, fill=True)

    def _draw_trail(
        self,
        layer: Layer,
        mapper: FrameMapper,
        pointer: HandPointer,
        options: OverlayOptions,
    ) -> None:
        trail = pointer.trail
        if len(trail) < 3:
            return

        trace = to_bgr(options.trace)
        for i in range(1, len(trail)):
            t = i / (len(trail) - 1)
            start = mapper.board_to_stage(trail[i - 1].x, trail[i - 1].y)
            end = mapper.board_to_stage(trail[i].x, trail[i].y)
            canvas.line(
                layer, (start.x, start.y), (end.x, end.y), trace, 0.22 * t * t, 1.5
            )

    def _draw_nib(
        self,
        layer: Layer,
        mapper: FrameMapper,
        pointer: HandPointer,
        options: OverlayOptions,
    ) -> None:
        point = mapper.board_to_stage(pointer.tip.x, pointer.tip.y)
        p: Point = (point.x, point.y)
        is_eraser = options.tool == "eraser"
        accent = to_bgr(options.paper if is_eraser else options.color)
        radius = max((options.brush * mapper.pixels_per_unit) / 2, 7.0)
        down = pointer.is_down

        # Ring — its radius is the actual stroke width, so you can size a line
        # before committing to it.
        if down and not is_eraser:
            canvas.circle(layer, p, radius, accent, 0.16, fill=True)
        if down:
            canvas.circle(layer, p, radius, accent, 0.95, width=1.75)
        else:
            canvas.dashed_circle(layer, p, radius, accent, 0.5, width=1.0)

        # Confidence arc — how close the gesture is to engaging.
        if not down and pointer.score > 0.02:
            sweep = clamp01(pointer.score) * 360.0
            canvas.arc(
                layer,
                p,
                radius + 6,
                -90.0,
                -90.0 + sweep,
                accent,
                lerp(0.25, 0.9, clamp01(pointer.score)),
                2.0,
            )

        # Registration ticks, retracted while the pen is down.
        tick_inner = radius + 3 if down else radius + 10
        tick_outer = radius + 7 if down else radius + 17
        tick_color = accent if down else to_bgr(options.dim)
        tick_alpha = 0.8 if down else 0.55
        for i in range(4):
            angle = i * math.pi / 2
            cos = math.cos(angle)
            sin = math.sin(angle)
            canvas.line(
                layer,
                (p[0] + cos * tick_inner, p[1] + sin * tick_inner),
                (p[0] + cos * tick_outer, p[1] + sin * tick_outer),
                tick_color,
                tick_alpha,
                1.0,
            )

        # Centre: a filled point once inking, a hairline cross while hovering.
        if down:
            canvas.circle(layer, p, 2.0, accent, 1.0, fill=True)
        else:
            canvas.line(layer, (p[0] - 3.5, p[1]), (p[0] + 3.5, p[1]), accent, 0.8, 1.0)
            canvas.line(layer, (p[0], p[1] - 3.5), (p[0], p[1] + 3.5), accent, 0.8, 1.0)

        self._draw_charge(layer, pointer.id, p, radius, accent, options.now)

    def _draw_charge(
        self,
        layer: Layer,
        pointer_id: int,
        p: Point,
        radius: float,
        accent: Bgr,
        now: float,
    ) -> None:
        """One-shot ring that collapses into the nib the instant the pen engages."""
        started_at = self._charges.get(pointer_id)
        if started_at is None:
            return

        t = (now - started_at) / CHARGE_MS
        if t >= 1:
            del self._charges[pointer_id]
            return

        eased = 1 - (1 - t) ** 3
        canvas.circle(
            layer, p, lerp(radius * 3, radius, eased), accent, (1 - t) * 0.9, width=2.0
        )

    def reset(self) -> None:
        self._charges.clear()
