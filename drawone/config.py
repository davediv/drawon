"""Tunable thresholds. Everything the feel of the app depends on lives here."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Tuple

from .lib.one_euro import OneEuroConfig

#: Board units: 1000 = the full height of the camera frame.
BOARD_HEIGHT = 1000.0


@dataclass(frozen=True)
class _Camera:
    ideal_width: int = 1280
    ideal_height: int = 720
    ideal_frame_rate: int = 60


@dataclass(frozen=True)
class _Tracking:
    num_hands: int = 2
    min_hand_detection_confidence: float = 0.55
    min_hand_presence_confidence: float = 0.55
    min_tracking_confidence: float = 0.55


@dataclass(frozen=True)
class _Gesture:
    #: Pinch distance (÷ hand scale) at which the pen is fully "down".
    pinch_closed: float = 0.34
    #: Pinch distance at which the pen is fully "up".
    pinch_open: float = 0.62

    #: Finger curl in degrees: at/below this the finger reads as extended.
    extended_curl: float = 42.0
    #: At/above this the finger reads as folded.
    folded_curl: float = 105.0

    #: Schmitt trigger — engage above, release below. The gap prevents flicker.
    engage_score: float = 0.62
    release_score: float = 0.42

    #: Consecutive frames required to change state. ~2 frames = 33 ms at 60 fps.
    engage_frames: int = 2
    release_frames: int = 2


@dataclass(frozen=True)
class _Smoothing:
    #: Slider 0..1 maps onto these 1€ filter endpoints.
    light: OneEuroConfig = OneEuroConfig(min_cutoff=4.2, beta=0.05, derivative_cutoff=1.0)
    heavy: OneEuroConfig = OneEuroConfig(min_cutoff=0.7, beta=0.006, derivative_cutoff=1.0)
    default: float = 0.55


@dataclass(frozen=True)
class _Stroke:
    #: Skip points closer than this (board units) — bounds stroke size and jitter.
    min_point_distance: float = 1.6
    #: A jump larger than this between consecutive samples means the tracker
    #: re-acquired a different hand position; break the stroke rather than draw
    #: a wild straight line across the board.
    max_jump_distance: float = 190.0
    #: Frames of tracking dropout tolerated before an in-progress stroke is closed.
    lost_frame_grace: int = 3
    min_width: int = 2
    max_width: int = 64
    default_pen_width: int = 9
    default_eraser_width: int = 42


CAMERA = _Camera()
TRACKING = _Tracking()
GESTURE = _Gesture()
SMOOTHING = _Smoothing()
STROKE = _Stroke()

PALETTE: Tuple[str, ...] = (
    "#ff5227",
    "#ffc53d",
    "#4adfd2",
    "#5b8cff",
    "#c77dff",
    "#4ade80",
    "#ff6fa5",
    "#eaf0f6",
)

DEFAULT_COLOR = PALETTE[2]

#: Interface palette, lifted from the web build's CSS custom properties. The
#: housing stays dark blue-graphite so it never glares against live video.
THEME = {
    "void": "#080b0f",
    "case": "#0e141b",
    "case2": "#151e28",
    "rule": "#1e2a36",
    "rule2": "#2c3d4d",
    "paper": "#eaf0f6",
    "dim": "#8095a8",
    "dim2": "#55697a",
    "signal": "#ff5227",
    "trace": "#4adfd2",
}
