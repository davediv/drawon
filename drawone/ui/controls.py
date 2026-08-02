"""Keyboard handling, the dock, the settings readout, the gate and toasts.

The web build had a DOM for this. Here the same controls are painted onto the
frame and driven from the keyboard, which is why every state the dock shows also
has a key that changes it.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Callable, List, Optional, Sequence, Tuple

import numpy as np

from ..board.board import BoardStats
from ..config import PALETTE, STROKE
from ..render.color import luminance, to_bgr
from ..types import Tool
from .settings import MODES, Settings, load_settings, save_settings
from .widgets import (
    LABEL,
    Palette,
    Rect,
    chip,
    meter,
    outline,
    panel,
    rule,
    text,
    text_size,
)

GESTURE_NOTES = {
    "pinch": "Touch your thumb to your index fingertip to ink. Separate them to lift the pen.",
    "point": "Extend your index finger and fold the other three to ink.",
    "grip": "Pinch with your ring and little fingers tucked in. Hardest to trigger by accident.",
    "any": "Any of the three gestures inks. Convenient, but easier to start a stroke by mistake.",
}

#: Single source of truth for the keyboard: what the help panel lists is what
#: `handle_key` dispatches.
KEYMAP: Sequence[Tuple[str, str]] = (
    ("P / E", "pen / eraser"),
    ("[ / ]", "brush size"),
    ("1-8", "palette colour"),
    ("Z / Y", "undo / redo"),
    ("C", "clear (undoable)"),
    ("S", "save transparent PNG"),
    ("shift+S", "save PNG with camera frame"),
    ("G", "gesture mode"),
    (", / .", "smoothing"),
    ("M / K / V", "mirror / skeleton / video"),
    ("N", "next camera"),
    ("H", "hide the controls"),
    ("?", "this list"),
    ("Q / Esc", "quit"),
)

TOAST_MS = 2200.0


@dataclass
class ControlHandlers:
    on_settings_change: Callable[[Settings, str], None] = lambda s, k: None
    on_undo: Callable[[], None] = lambda: None
    on_redo: Callable[[], None] = lambda: None
    on_clear: Callable[[], None] = lambda: None
    on_save: Callable[[str], None] = lambda mode: None
    on_next_camera: Callable[[], None] = lambda: None
    on_quit: Callable[[], None] = lambda: None


@dataclass
class GateContent:
    title: str
    body: str = ""
    fine: str = ""
    action: str = ""


class Controls:
    def __init__(self, handlers: ControlHandlers) -> None:
        self._handlers = handlers
        self.settings = load_settings()
        self._stats = BoardStats(0, False, False)
        self._hidden = False
        self._help = False
        self._gate_state = "hidden"
        self._gate: Optional[GateContent] = None
        self._toast = ""
        self._toast_at = -1e9

    @property
    def active_width(self) -> int:
        return self.settings.active_width

    @property
    def gate_state(self) -> str:
        return self._gate_state

    # ---- state ------------------------------------------------------------

    def set_history(self, stats: BoardStats) -> None:
        self._stats = stats

    def set_gate(self, state: str, content: Optional[GateContent] = None) -> None:
        self._gate_state = state
        if content is not None:
            self._gate = content

    def toast(self, message: str) -> None:
        self._toast = message
        self._toast_at = time.perf_counter() * 1000.0

    def _commit(self, key: str) -> None:
        save_settings(self.settings)
        self._handlers.on_settings_change(self.settings, key)

    def _set_tool(self, tool: Tool) -> None:
        if self.settings.tool == tool:
            return
        self.settings.tool = tool
        self._commit("tool")

    def _pick_color(self, color: str) -> None:
        self.settings.color = color.lower()
        # Choosing a colour is also a statement of intent to draw, not erase.
        if self.settings.tool == "eraser":
            self.settings.tool = "pen"
        self._commit("color")

    def _set_width(self, width: float) -> None:
        clamped = int(min(max(round(width), STROKE.min_width), STROKE.max_width))
        if self.settings.tool == "eraser":
            self.settings.eraser_width = clamped
            self._commit("eraser_width")
        else:
            self.settings.pen_width = clamped
            self._commit("pen_width")

    def _nudge_width(self, delta: int) -> None:
        self._set_width(self.active_width + delta)

    def _cycle_gesture(self) -> None:
        index = MODES.index(self.settings.gesture_mode)
        mode = MODES[(index + 1) % len(MODES)]
        self.settings.gesture_mode = mode  # type: ignore[assignment]
        self._commit("gesture_mode")
        self.toast("{} - {}".format(mode, GESTURE_NOTES[mode]))

    def _nudge_smoothing(self, delta: float) -> None:
        self.settings.smoothing = min(max(self.settings.smoothing + delta, 0.0), 1.0)
        self._commit("smoothing")

    # ---- keyboard ---------------------------------------------------------

    def handle_key(self, key: int) -> bool:
        """Returns False when the app should quit."""
        if key < 0:
            return True
        code = key & 0xFF

        if code in (27, ord("q")):  # Esc
            if code == 27 and self._help:
                self._help = False
                return True
            self._handlers.on_quit()
            return False

        char = chr(code) if 32 <= code < 127 else ""

        if char in ("?", "/"):
            self._help = not self._help
            return True
        if char == "p":
            self._set_tool("pen")
        elif char == "e":
            self._set_tool("eraser")
        elif char == "[":
            self._nudge_width(-2)
        elif char == "]":
            self._nudge_width(2)
        elif char == "z":
            self._handlers.on_undo()
        elif char in ("Z", "y", "Y"):
            self._handlers.on_redo()
        elif char == "c":
            self._handlers.on_clear()
        elif char == "s":
            self._handlers.on_save("ink")
        elif char == "S":
            self._handlers.on_save("composite")
        elif char == "h":
            self._hidden = not self._hidden
        elif char == "g":
            self._cycle_gesture()
        elif char == ",":
            self._nudge_smoothing(-0.05)
        elif char == ".":
            self._nudge_smoothing(0.05)
        elif char == "m":
            self.settings.mirror = not self.settings.mirror
            self._commit("mirror")
        elif char == "k":
            self.settings.show_skeleton = not self.settings.show_skeleton
            self._commit("show_skeleton")
        elif char == "v":
            self.settings.show_video = not self.settings.show_video
            self._commit("show_video")
        elif char == "n":
            self._handlers.on_next_camera()
        elif char.isdigit():
            index = int(char) - 1
            if 0 <= index < len(PALETTE):
                self._pick_color(PALETTE[index])

        return True

    # ---- rendering --------------------------------------------------------

    def render(self, image: np.ndarray, scale: float) -> None:
        # The gate is modal: while it is up there is no session to control, so
        # nothing else competes with it for the frame.
        if self._gate_state != "hidden" and self._gate is not None:
            self._draw_gate(image, scale)
            self._draw_toast(image, scale)
            return

        if not self._hidden:
            self._draw_dock(image, scale)
            self._draw_settings(image, scale)
        if self._help:
            self._draw_help(image, scale)
        self._draw_toast(image, scale)

    def _draw_dock(self, image: np.ndarray, scale: float) -> None:
        height, width = image.shape[:2]

        def s(value: float) -> int:
            return int(round(value * scale))

        chip_w, chip_h = s(58), s(24)
        swatch = s(17)
        swatch_gap = s(5)
        gap = s(8)
        group_gap = s(16)
        meter_w = s(74)

        tools_w = chip_w * 2 + gap
        swatches_w = len(PALETTE) * swatch + (len(PALETTE) - 1) * swatch_gap
        size_w = s(30) + meter_w + s(28)
        actions_w = chip_w * 4 + gap * 3
        content = tools_w + swatches_w + size_w + actions_w + group_gap * 3
        pad = s(14)

        dock_w = content + pad * 2
        dock_h = chip_h + pad * 2
        x0 = (width - dock_w) // 2
        y0 = height - dock_h - s(34)
        panel(image, (x0, y0, x0 + dock_w, y0 + dock_h), Palette.case, 0.82,
              border=Palette.rule)

        x = x0 + pad
        row_y = y0 + pad
        label_size = 0.36 * scale

        chip(image, "PEN", (x, row_y, x + chip_w, row_y + chip_h),
             active=self.settings.tool == "pen",
             accent=to_bgr(self.settings.color), size=label_size)
        x += chip_w + gap
        chip(image, "ERASER", (x, row_y, x + chip_w, row_y + chip_h),
             active=self.settings.tool == "eraser", accent=Palette.paper,
             size=label_size)
        x += chip_w + group_gap

        for color in PALETTE:
            rect: Rect = (x, row_y + s(3), x + swatch, row_y + s(3) + swatch)
            panel(image, rect, to_bgr(color), 1.0)
            if color.lower() == self.settings.color.lower():
                # A light swatch would vanish into the panel without this.
                edge = Palette.void if luminance(color) > 0.7 else Palette.paper
                outline(image, (rect[0] - s(2), rect[1] - s(2), rect[2] + s(2),
                                rect[3] + s(2)), edge)
            x += swatch + swatch_gap
        x += group_gap - swatch_gap

        text(image, "SIZE", x, row_y + s(7), Palette.dim2, label_size, 1, LABEL)
        x += s(30)
        span = STROKE.max_width - STROKE.min_width
        meter(image, (x, row_y + s(9), x + meter_w, row_y + s(14)),
              (self.active_width - STROKE.min_width) / span,
              to_bgr(self.settings.color) if self.settings.tool == "pen" else Palette.paper)
        x += meter_w + s(6)
        text(image, str(self.active_width), x, row_y + s(7), Palette.paper,
             label_size, 1, LABEL)
        x += s(22) + group_gap

        actions = (
            ("UNDO", self._stats.can_undo),
            ("REDO", self._stats.can_redo),
            ("CLEAR", self._stats.strokes > 0),
            ("SAVE", self._stats.strokes > 0),
        )
        for label, enabled in actions:
            chip(image, label, (x, row_y, x + chip_w, row_y + chip_h),
                 enabled=enabled, size=label_size)
            x += chip_w + gap

        hint = "P pen  E eraser  [ ] size  1-8 colour  Z undo  C clear  S save  ? keys"
        text(image, hint, width / 2, y0 + dock_h + s(8), Palette.dim2,
             0.33 * scale, 1, LABEL, align="center")

    def _draw_settings(self, image: np.ndarray, scale: float) -> None:
        def s(value: float) -> int:
            return int(round(value * scale))

        rows = (
            ("GESTURE", self.settings.gesture_mode),
            ("SMOOTH", "{}%".format(round(self.settings.smoothing * 100))),
            ("MIRROR", "on" if self.settings.mirror else "off"),
            ("SKELETON", "on" if self.settings.show_skeleton else "off"),
            ("VIDEO", "on" if self.settings.show_video else "off"),
            ("CAMERA", str(self.settings.camera_id)),
        )

        width = image.shape[1]
        pad = s(12)
        box_w = s(132)
        line = s(15)
        box_h = line * len(rows) + s(14)
        x0 = width - box_w - pad
        y0 = pad
        panel(image, (x0, y0, x0 + box_w, y0 + box_h), Palette.case, 0.72,
              border=Palette.rule)

        size = 0.34 * scale
        y = y0 + s(7)
        for label, value in rows:
            text(image, label, x0 + s(10), y, Palette.dim2, size, 1, LABEL)
            text(image, value, x0 + box_w - s(10), y, Palette.dim, size, 1, LABEL,
                 align="right")
            y += line

    def _draw_help(self, image: np.ndarray, scale: float) -> None:
        def s(value: float) -> int:
            return int(round(value * scale))

        height, width = image.shape[:2]
        line = s(19)
        box_w = s(330)
        box_h = line * len(KEYMAP) + s(46)
        x0 = (width - box_w) // 2
        y0 = (height - box_h) // 2
        panel(image, (x0, y0, x0 + box_w, y0 + box_h), Palette.case, 0.94,
              border=Palette.rule2)

        size = 0.38 * scale
        text(image, "KEYS", x0 + s(18), y0 + s(14), Palette.paper, size * 1.1, 1, LABEL)
        rule(image, x0 + s(18), y0 + s(32), x0 + box_w - s(18))

        y = y0 + s(40)
        for combo, description in KEYMAP:
            text(image, combo, x0 + s(18), y, Palette.trace, size, 1, LABEL)
            text(image, description, x0 + s(128), y, Palette.dim, size, 1, LABEL)
            y += line

    def _draw_gate(self, image: np.ndarray, scale: float) -> None:
        assert self._gate is not None
        gate = self._gate

        def s(value: float) -> int:
            return int(round(value * scale))

        height, width = image.shape[:2]
        panel(image, (0, 0, width, height), Palette.void, 0.8)

        error = self._gate_state == "error"
        title_size = 0.66 * scale
        body_size = 0.4 * scale
        line = s(21)

        lines = _wrap(gate.body, body_size, int(width * 0.48))
        widths = [text_size(gate.title, title_size, 1, LABEL)[0]]
        widths += [text_size(entry, body_size, 1, LABEL)[0] for entry in lines]
        if gate.action:
            widths.append(text_size(gate.action, body_size, 1, LABEL)[0])
        if gate.fine:
            widths.append(text_size(gate.fine, body_size * 0.9, 1, LABEL)[0])

        pad = s(30)
        box_w = min(max(widths) + pad * 2, width - s(40))
        box_h = (
            s(34)
            + len(lines) * line
            + (line + s(8) if gate.action else 0)
            + (line if gate.fine else 0)
            + pad
        )
        x0 = (width - box_w) // 2
        y0 = (height - box_h) // 2
        panel(image, (x0, y0, x0 + box_w, y0 + box_h), Palette.case, 0.95,
              border=Palette.signal if error else Palette.rule2)

        centre = x0 + box_w / 2
        y = y0 + s(22)
        text(image, gate.title, centre, y, Palette.signal if error else Palette.paper,
             title_size, 1, LABEL, align="center")
        y += s(34)
        for entry in lines:
            text(image, entry, centre, y, Palette.dim, body_size, 1, LABEL, align="center")
            y += line
        if gate.action:
            y += s(8)
            text(image, gate.action, centre, y, Palette.trace, body_size, 1, LABEL,
                 align="center")
            y += line
        if gate.fine:
            text(image, gate.fine, centre, y, Palette.dim2, body_size * 0.9, 1, LABEL,
                 align="center")

    def _draw_toast(self, image: np.ndarray, scale: float) -> None:
        if not self._toast:
            return
        elapsed = time.perf_counter() * 1000.0 - self._toast_at
        if elapsed > TOAST_MS:
            self._toast = ""
            return

        def s(value: float) -> int:
            return int(round(value * scale))

        height, width = image.shape[:2]
        size = 0.38 * scale
        text_w, text_h = text_size(self._toast, size, 1, LABEL)
        pad = s(12)
        box_w = text_w + pad * 2
        box_h = text_h + pad
        x0 = (width - box_w) // 2
        y0 = height - box_h - s(88)
        panel(image, (x0, y0, x0 + box_w, y0 + box_h), Palette.case2, 0.92,
              border=Palette.rule2)
        text(image, self._toast, width / 2, y0 + pad / 2 - s(1), Palette.paper,
             size, 1, LABEL, align="center")


def _wrap(value: str, size: float, max_width: int) -> List[str]:
    if not value:
        return []
    words = value.split()
    lines: List[str] = []
    current = ""
    for word in words:
        candidate = "{} {}".format(current, word).strip()
        if current and text_size(candidate, size, 1, LABEL)[0] > max_width:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines
