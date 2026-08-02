"""Per-frame detections into stable, smoothed pen pointers.

MediaPipe hands out an array with no identity guarantee across frames, so
detections are matched to existing slots by wrist proximity. Identity matters
here: each slot carries its own filter state and pen-down latch, and mixing two
hands' histories would teleport a stroke between them.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import List, Optional, Set

from ..config import SMOOTHING, STROKE
from ..lib.one_euro import OneEuroConfig, OneEuroPoint
from ..types import BoardPoint, GestureMode, Vec2, Vec3
from .frame_mapper import FrameMapper
from .gesture import GestureName, HandMetrics, PenTrigger, measure_hand, score_gesture
from .landmarks import LM

TRAIL_LENGTH = 16
#: Normalized-space radius within which a detection is considered the same hand.
MATCH_RADIUS = 0.28


def smoothing_config(amount: float) -> OneEuroConfig:
    """Slider 0..1 to filter constants, interpolated geometrically so the feel is even."""
    t = min(max(amount, 0.0), 1.0)
    light, heavy = SMOOTHING.light, SMOOTHING.heavy

    def geo(a: float, b: float) -> float:
        return a * (b / a) ** t

    return OneEuroConfig(
        min_cutoff=geo(light.min_cutoff, heavy.min_cutoff),
        beta=geo(light.beta, heavy.beta),
        derivative_cutoff=light.derivative_cutoff,
    )


@dataclass
class HandsFrame:
    """One inference result, in plain values.

    Deliberately not a MediaPipe type: keeping the tracker's output structural
    means the pointer logic (and its tests) never need the model loaded.
    """

    #: Normalized image landmarks per hand, 21 each, x/y in 0..1.
    landmarks: List[List[Vec3]] = field(default_factory=list)
    #: Metric world landmarks per hand, 21 each, in metres.
    world: List[List[Vec3]] = field(default_factory=list)
    #: 'Left' | 'Right' as reported by the model, already un-mirrored by MediaPipe.
    handedness: List[str] = field(default_factory=list)


@dataclass
class HandPointer:
    id: int
    handedness: str
    landmarks: List[Vec3]
    metrics: HandMetrics
    #: Smoothed index-fingertip position, in board units — this is the pen nib.
    tip: BoardPoint
    #: Raw, unsmoothed nib position; used to measure how much filtering is doing.
    raw_tip: BoardPoint
    score: float
    gesture: GestureName
    is_down: bool
    just_pressed: bool
    just_released: bool
    #: Recent nib positions in board units, newest last.
    trail: List[BoardPoint]


@dataclass
class _Slot:
    id: int
    filter: OneEuroPoint
    trigger: PenTrigger
    trail: List[BoardPoint]
    last_wrist: Vec2
    last_seen_frame: int


@dataclass(frozen=True)
class PointerUpdate:
    mapper: FrameMapper
    gesture_mode: GestureMode
    smoothing: float
    #: Monotonic seconds, for the 1€ filter.
    time: float
    frame: int


class PointerTracker:
    def __init__(self) -> None:
        self._slots: List[_Slot] = []
        self._next_id = 1
        self._smoothing = SMOOTHING.default
        #: Slots dropped this frame, so the caller can close their strokes.
        self.retired: List[int] = []

    def update(
        self, result: Optional[HandsFrame], options: PointerUpdate
    ) -> List[HandPointer]:
        self.retired.clear()

        if options.smoothing != self._smoothing:
            self._smoothing = options.smoothing
            config = smoothing_config(self._smoothing)
            for slot in self._slots:
                slot.filter.configure(config)

        pointers: List[HandPointer] = []
        hands = result.landmarks if result else []
        claimed: Set[int] = set()

        for i, landmarks in enumerate(hands):
            world = result.world[i] if result and i < len(result.world) else None
            if not landmarks or not world or len(landmarks) < 21 or len(world) < 21:
                continue

            wrist = landmarks[LM.WRIST]
            slot = self._acquire_slot(wrist, claimed, options.frame)

            metrics = measure_hand(world)
            reading = score_gesture(metrics, options.gesture_mode)
            is_down = slot.trigger.update(reading.score)

            tip_landmark = landmarks[LM.INDEX_TIP]
            raw = options.mapper.normalized_to_board(tip_landmark.x, tip_landmark.y)
            smoothed = slot.filter.filter(raw.x, raw.y, options.time)

            slot.trail.append(smoothed)
            if len(slot.trail) > TRAIL_LENGTH:
                slot.trail.pop(0)

            handedness = ""
            if result and i < len(result.handedness):
                handedness = result.handedness[i]

            pointers.append(
                HandPointer(
                    id=slot.id,
                    handedness=handedness,
                    landmarks=landmarks,
                    metrics=metrics,
                    tip=smoothed,
                    raw_tip=raw,
                    score=reading.score,
                    gesture=reading.name,
                    is_down=is_down,
                    just_pressed=slot.trigger.just_pressed,
                    just_released=slot.trigger.just_released,
                    trail=slot.trail,
                )
            )

        self._retire_stale_slots(options.frame)
        return pointers

    def _acquire_slot(self, wrist: Vec3, claimed: Set[int], frame: int) -> _Slot:
        best: Optional[_Slot] = None
        best_distance = MATCH_RADIUS

        for slot in self._slots:
            if slot.id in claimed:
                continue
            distance = math.hypot(wrist.x - slot.last_wrist.x, wrist.y - slot.last_wrist.y)
            if distance < best_distance:
                best = slot
                best_distance = distance

        if best is None:
            best = _Slot(
                id=self._next_id,
                filter=OneEuroPoint(smoothing_config(self._smoothing)),
                trigger=PenTrigger(),
                trail=[],
                last_wrist=Vec2(wrist.x, wrist.y),
                last_seen_frame=frame,
            )
            self._next_id += 1
            self._slots.append(best)

        claimed.add(best.id)
        best.last_wrist = Vec2(wrist.x, wrist.y)
        best.last_seen_frame = frame
        return best

    def _retire_stale_slots(self, frame: int) -> None:
        """A hand that vanishes for a frame or two is almost always a detection
        blip, not the user lowering their hand. Holding the slot open across that
        gap stops a single dropped frame from chopping a stroke in half.
        """
        kept: List[_Slot] = []
        for slot in self._slots:
            if frame - slot.last_seen_frame <= STROKE.lost_frame_grace:
                kept.append(slot)
            else:
                self.retired.append(slot.id)
        self._slots = kept

    def reset(self) -> None:
        """Drops all identity and filter state. Callers must close any open
        strokes themselves.
        """
        self._slots = []
        self.retired.clear()
