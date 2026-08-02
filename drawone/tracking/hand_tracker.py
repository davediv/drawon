"""MediaPipe HandLandmarker wrapper.

The model file is the same `hand_landmarker.task` the web build vendored, so
nothing is downloaded at runtime and the app works offline.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Callable, List, Optional

import cv2
import numpy as np

from ..config import TRACKING
from ..types import Vec3
from .pointers import HandsFrame

MODEL_FILENAME = "hand_landmarker.task"


def default_model_path() -> Optional[Path]:
    """Finds the vendored model without needing an install step.

    It ships inside the package, so this resolves whether Drawone is installed
    or run straight from a checkout. The working directory is tried last, for
    anyone keeping the file next to their own script.
    """
    here = Path(__file__).resolve()
    candidates = [
        here.parent.parent / "models" / MODEL_FILENAME,
        Path.cwd() / "drawone" / "models" / MODEL_FILENAME,
        Path.cwd() / MODEL_FILENAME,
    ]
    env = os.environ.get("DRAWONE_MODEL")
    if env:
        candidates.insert(0, Path(env))
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


class HandTracker:
    def __init__(self) -> None:
        self._landmarker = None
        self._mp = None
        self._last_timestamp = -1
        self.delegate = "CPU"

    @property
    def ready(self) -> bool:
        return self._landmarker is not None

    def load(
        self,
        model_path: Optional[Path] = None,
        on_progress: Optional[Callable[[str], None]] = None,
        prefer_gpu: bool = True,
    ) -> None:
        # MediaPipe logs a paragraph of INFO lines through glog on the way up.
        os.environ.setdefault("GLOG_minloglevel", "2")

        import mediapipe as mp
        from mediapipe.tasks.python import BaseOptions
        from mediapipe.tasks.python.vision import (
            HandLandmarker,
            HandLandmarkerOptions,
            RunningMode,
        )

        self._mp = mp

        path = Path(model_path) if model_path else default_model_path()
        if path is None or not path.is_file():
            raise FileNotFoundError(
                "hand_landmarker.task was not found. Pass --model /path/to/"
                "hand_landmarker.task, or put it in drawone/models/."
            )

        def build(delegate) -> object:
            return HandLandmarker.create_from_options(
                HandLandmarkerOptions(
                    base_options=BaseOptions(
                        model_asset_path=str(path), delegate=delegate
                    ),
                    running_mode=RunningMode.VIDEO,
                    num_hands=TRACKING.num_hands,
                    min_hand_detection_confidence=TRACKING.min_hand_detection_confidence,
                    min_hand_presence_confidence=TRACKING.min_hand_presence_confidence,
                    min_tracking_confidence=TRACKING.min_tracking_confidence,
                )
            )

        if on_progress:
            on_progress("Loading hand model")

        if prefer_gpu:
            try:
                self._landmarker = build(BaseOptions.Delegate.GPU)
                self.delegate = "GPU"
                return
            except Exception:
                # No usable GPU delegate on this platform — macOS wheels in
                # particular ship CPU-only. Slower, but working beats dead.
                if on_progress:
                    on_progress("Falling back to CPU inference")

        self._landmarker = build(BaseOptions.Delegate.CPU)
        self.delegate = "CPU"

    def detect(self, frame_bgr: np.ndarray, timestamp_ms: float) -> Optional[HandsFrame]:
        """`timestamp_ms` must increase monotonically — MediaPipe rejects a frame
        stamped at or before the previous one.
        """
        if self._landmarker is None or self._mp is None:
            return None

        mp = self._mp
        timestamp = int(timestamp_ms)
        if timestamp <= self._last_timestamp:
            timestamp = self._last_timestamp + 1
        self._last_timestamp = timestamp

        try:
            # SRGBA, not SRGB. The GPU delegate cannot upload a three-channel
            # ImageFrame and aborts the process on a failed CHECK rather than
            # raising, so there is nothing to catch and fall back from. The
            # fourth channel costs 0.2 ms and is marginally faster on CPU too.
            rgba = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGBA)
            image = mp.Image(image_format=mp.ImageFormat.SRGBA, data=rgba)
            result = self._landmarker.detect_for_video(image, timestamp)
        except Exception:
            return None

        return _to_hands_frame(result)

    def close(self) -> None:
        if self._landmarker is not None:
            self._landmarker.close()
        self._landmarker = None
        self._last_timestamp = -1


def _points(group) -> List[Vec3]:
    return [Vec3(p.x, p.y, p.z) for p in group]


def _to_hands_frame(result) -> HandsFrame:
    if result is None:
        return HandsFrame()

    handedness: List[str] = []
    for categories in getattr(result, "handedness", []) or []:
        handedness.append(categories[0].category_name if categories else "")

    return HandsFrame(
        landmarks=[_points(h) for h in (result.hand_landmarks or [])],
        world=[_points(h) for h in (result.hand_world_landmarks or [])],
        handedness=handedness,
    )
