"""The live readout in the top-left corner."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .widgets import LABEL, Palette, panel, rule, text


@dataclass(frozen=True)
class HudReading:
    state: str
    fps: float
    track_ms: float
    pipe_ms: float
    hands: int


class Hud:
    """Numbers change every frame; a readout that does the same is unreadable.

    The state light follows the pen immediately — it is a control cue — while the
    counters latch at ~6 Hz so they can actually be read.
    """

    def __init__(self) -> None:
        self._state = "idle"
        self._values = ["-", "-", "-", "0"]
        self._last_latch = 0.0
        self._meta = ""

    def update(self, reading: HudReading, now_ms: float) -> None:
        self._state = reading.state
        if now_ms - self._last_latch < 160:
            return
        self._last_latch = now_ms
        self._values = [
            str(round(reading.fps)) if reading.fps > 0 else "-",
            "{:.1f}ms".format(reading.track_ms) if reading.track_ms > 0 else "-",
            "{}ms".format(round(reading.pipe_ms)) if reading.pipe_ms > 0 else "-",
            str(reading.hands),
        ]

    def set_meta(self, value: str) -> None:
        self._meta = value

    def reset(self) -> None:
        self._values = ["-", "-", "-", "0"]
        self._state = "idle"

    def render(self, image: np.ndarray, scale: float) -> None:
        pad = int(round(12 * scale))
        line = int(round(15 * scale))
        size = 0.36 * scale
        width = int(round(150 * scale))
        height = int(round(28 + line * 4 + (14 if self._meta else 0)) * scale)

        panel(image, (pad, pad, pad + width, pad + height), Palette.case, 0.72,
              border=Palette.rule)

        x = pad + int(round(10 * scale))
        y = pad + int(round(8 * scale))

        text(image, "DRAWONE", x, y, Palette.paper, size, 1, LABEL)
        light = Palette.trace if self._state == "inking" else Palette.dim
        text(image, self._state.upper(), pad + width - int(round(10 * scale)), y,
             light, size, 1, LABEL, align="right")

        y += int(round(14 * scale))
        rule(image, x, y, pad + width - int(round(10 * scale)))
        y += int(round(6 * scale))

        for label, value in zip(("FPS", "TRACK", "PIPE", "HANDS"), self._values):
            text(image, label, x, y, Palette.dim2, size, 1, LABEL)
            text(image, value, pad + width - int(round(10 * scale)), y,
                 Palette.dim, size, 1, LABEL, align="right")
            y += line

        if self._meta:
            text(image, self._meta, x, y, Palette.dim2, size * 0.92, 1, LABEL)
