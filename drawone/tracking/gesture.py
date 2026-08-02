"""Gesture classification and the pen-down latch.

Everything is measured on MediaPipe's *world* landmarks — metric 3D coordinates
relative to the hand's centre — rather than the projected image landmarks. That
matters: a finger curling toward the camera collapses to almost nothing in 2D,
so an image-space classifier reads it as extended and the pen sticks down. In 3D
the joint angle is unambiguous from any angle.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Literal

from ..config import GESTURE
from ..lib.maths import angle_at, dist3, smooth_ramp
from ..types import GestureMode, Vec3
from .landmarks import FINGER_JOINTS, FINGERS, LM


@dataclass(frozen=True)
class HandMetrics:
    #: Total flexion per finger in degrees. ~10 = straight, ~200 = fully folded.
    curls: Dict[str, float]
    #: Thumb-tip to index-tip distance, divided by hand size so it is
    #: user-independent.
    pinch: float
    #: Wrist to middle-knuckle distance in metres — the reference length.
    hand_scale: float


def _curl_of(world: List[Vec3], finger: str) -> float:
    a, b, c, d = FINGER_JOINTS[finger]
    # Flexion at the two hinge joints, summed. Using both means a finger folded
    # only at the tip still reads as partially curled.
    proximal = 180.0 - angle_at(world[b], world[a], world[c])
    distal = 180.0 - angle_at(world[c], world[b], world[d])
    return proximal + distal


def measure_hand(world: List[Vec3]) -> HandMetrics:
    hand_scale = max(dist3(world[LM.WRIST], world[LM.MIDDLE_MCP]), 1e-4)
    curls = {finger: _curl_of(world, finger) for finger in FINGERS}
    return HandMetrics(
        curls=curls,
        pinch=dist3(world[LM.THUMB_TIP], world[LM.INDEX_TIP]) / hand_scale,
        hand_scale=hand_scale,
    )


def _extended(curl: float) -> float:
    """1 when the finger is straight, 0 when folded."""
    return smooth_ramp(GESTURE.folded_curl, GESTURE.extended_curl, curl)


def _folded(curl: float) -> float:
    """1 when the finger is folded, 0 when straight."""
    return smooth_ramp(GESTURE.extended_curl, GESTURE.folded_curl, curl)


GestureName = Literal["pinch", "point", "grip"]


@dataclass(frozen=True)
class GestureReading:
    #: 0..1 confidence that the user is holding a pen right now.
    score: float
    #: Which sub-gesture produced that score.
    name: GestureName


def _pinch_score(m: HandMetrics) -> float:
    """Thumb and index tips touching — a stylus grip."""
    return smooth_ramp(GESTURE.pinch_open, GESTURE.pinch_closed, m.pinch)


def _point_score(m: HandMetrics) -> float:
    """Index extended, the rest folded away — a pointing finger."""
    return min(
        _extended(m.curls["index"]),
        _folded(m.curls["middle"]),
        _folded(m.curls["ring"]),
        _folded(m.curls["pinky"]),
    )


def _grip_score(m: HandMetrics) -> float:
    """A real pen grip: pinched, with the last two fingers tucked in."""
    return min(_pinch_score(m), _folded(m.curls["ring"]), _folded(m.curls["pinky"]))


def score_gesture(m: HandMetrics, mode: GestureMode) -> GestureReading:
    if mode == "pinch":
        return GestureReading(_pinch_score(m), "pinch")
    if mode == "point":
        return GestureReading(_point_score(m), "point")
    if mode == "grip":
        return GestureReading(_grip_score(m), "grip")

    candidates = (
        GestureReading(_grip_score(m), "grip"),
        GestureReading(_pinch_score(m), "pinch"),
        GestureReading(_point_score(m), "point"),
    )
    best = candidates[0]
    for candidate in candidates[1:]:
        if candidate.score > best.score:
            best = candidate
    return best


class PenTrigger:
    """Turns a noisy confidence signal into a clean pen-down/pen-up state.

    Two mechanisms, because either alone is not enough: a Schmitt trigger (wide
    gap between the engage and release thresholds) stops a score hovering at the
    boundary from chattering, and a short frame count stops a single bad
    detection from starting or ending a stroke. Release uses the same small frame
    count as engage so letting go still feels instantaneous.
    """

    def __init__(self) -> None:
        self._down = False
        self._streak = 0
        self._edge = "none"

    def update(self, score: float) -> bool:
        self._edge = "none"

        if self._down:
            if score < GESTURE.release_score:
                self._streak += 1
                if self._streak >= GESTURE.release_frames:
                    self._down = False
                    self._streak = 0
                    self._edge = "release"
            else:
                self._streak = 0
        else:
            if score > GESTURE.engage_score:
                self._streak += 1
                if self._streak >= GESTURE.engage_frames:
                    self._down = True
                    self._streak = 0
                    self._edge = "press"
            else:
                self._streak = 0

        return self._down

    @property
    def is_down(self) -> bool:
        return self._down

    @property
    def just_pressed(self) -> bool:
        """True only on the frame the pen went down — used for the ink-charge cue."""
        return self._edge == "press"

    @property
    def just_released(self) -> bool:
        return self._edge == "release"

    def reset(self) -> None:
        self._down = False
        self._streak = 0
        self._edge = "none"
