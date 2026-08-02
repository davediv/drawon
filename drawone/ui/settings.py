"""User preferences, persisted between runs."""

from __future__ import annotations

import json
import os
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Dict, Optional

from ..config import DEFAULT_COLOR, SMOOTHING, STROKE
from ..types import GestureMode, Tool

TOOLS = ("pen", "eraser")
MODES = ("pinch", "point", "grip", "any")

_HEX = re.compile(r"^#[0-9a-f]{6}$")


def settings_path() -> Path:
    override = os.environ.get("DRAWONE_SETTINGS")
    if override:
        return Path(override)
    return Path.home() / ".drawone" / "settings.json"


@dataclass
class Settings:
    tool: Tool = "pen"
    color: str = DEFAULT_COLOR.lower()
    pen_width: int = STROKE.default_pen_width
    eraser_width: int = STROKE.default_eraser_width
    gesture_mode: GestureMode = "pinch"
    #: 0 = most responsive, 1 = steadiest.
    smoothing: float = SMOOTHING.default
    mirror: bool = True
    show_skeleton: bool = True
    show_video: bool = True
    camera_id: int = 0

    @property
    def active_width(self) -> int:
        return self.eraser_width if self.tool == "eraser" else self.pen_width


def _normalise_color(value: Any) -> Optional[str]:
    """Colours are compared as strings all over the UI, so there is one casing."""
    text = str(value).lower()
    return text if _HEX.match(text) else None


def _clamp_width(value: Any, fallback: int) -> int:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    if number != number or number in (float("inf"), float("-inf")):
        return fallback
    return int(min(max(round(number), STROKE.min_width), STROKE.max_width))


def _clamp_unit(value: Any, fallback: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    if number != number:
        return fallback
    return min(max(number, 0.0), 1.0)


def load_settings(path: Optional[Path] = None) -> Settings:
    """Anything unrecognised falls back to the default — stored settings are untrusted."""
    target = Path(path) if path else settings_path()
    stored: Dict[str, Any] = {}
    try:
        with target.open("r", encoding="utf-8") as handle:
            loaded = json.load(handle)
        if isinstance(loaded, dict):
            stored = loaded
    except (OSError, ValueError):
        stored = {}

    defaults = Settings()
    camera = stored.get("camera_id", defaults.camera_id)

    return Settings(
        tool=stored.get("tool") if stored.get("tool") in TOOLS else defaults.tool,
        color=_normalise_color(stored.get("color")) or defaults.color,
        pen_width=_clamp_width(stored.get("pen_width"), defaults.pen_width),
        eraser_width=_clamp_width(stored.get("eraser_width"), defaults.eraser_width),
        gesture_mode=(
            stored.get("gesture_mode")
            if stored.get("gesture_mode") in MODES
            else defaults.gesture_mode
        ),
        smoothing=_clamp_unit(stored.get("smoothing"), defaults.smoothing),
        mirror=bool(stored.get("mirror", defaults.mirror)),
        show_skeleton=bool(stored.get("show_skeleton", defaults.show_skeleton)),
        show_video=bool(stored.get("show_video", defaults.show_video)),
        camera_id=int(camera) if isinstance(camera, (int, float)) else defaults.camera_id,
    )


def save_settings(settings: Settings, path: Optional[Path] = None) -> None:
    target = Path(path) if path else settings_path()
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("w", encoding="utf-8") as handle:
            json.dump(asdict(settings), handle, indent=2)
    except OSError:
        # A read-only home or a full disk — preferences just will not persist.
        pass
