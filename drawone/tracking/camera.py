"""Webcam capture.

Frames are pulled on a background thread that only ever keeps the newest one.
OpenCV's internal queue would otherwise hand back frames that are already stale
by the time inference finishes, and latency is the whole game here: the point of
air-drawing is that the line feels attached to your fingertip.
"""

from __future__ import annotations

import contextlib
import os
import platform
import sys
import threading
import time
from dataclasses import dataclass
from typing import Iterator, List, Optional

import cv2
import numpy as np

from ..config import CAMERA

FIRST_FRAME_TIMEOUT_S = 15.0


class CameraError(Exception):
    def __init__(self, message: str, hint: str) -> None:
        super().__init__(message)
        self.message = message
        self.hint = hint


@dataclass(frozen=True)
class CameraSettings:
    index: int
    width: int
    height: int
    frame_rate: float


@dataclass(frozen=True)
class Frame:
    #: Monotonic counter — the loop uses it to skip re-running inference on a
    #: frame it has already seen.
    id: int
    image: np.ndarray
    #: perf_counter() seconds at capture, for the capture-to-ink measurement.
    captured_at: float


def _backend() -> int:
    system = platform.system()
    if system == "Darwin":
        return cv2.CAP_AVFOUNDATION
    if system == "Windows":
        return cv2.CAP_DSHOW
    if system == "Linux":
        return cv2.CAP_V4L2
    return cv2.CAP_ANY


class Camera:
    def __init__(self) -> None:
        self._capture: Optional[cv2.VideoCapture] = None
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._frame: Optional[Frame] = None
        self._counter = 0
        self._settings: Optional[CameraSettings] = None

    @property
    def active(self) -> bool:
        return self._capture is not None

    @property
    def settings(self) -> Optional[CameraSettings]:
        return self._settings

    def start(
        self,
        index: int = 0,
        width: int = CAMERA.ideal_width,
        height: int = CAMERA.ideal_height,
        frame_rate: int = CAMERA.ideal_frame_rate,
    ) -> None:
        self.stop()

        capture = cv2.VideoCapture(index, _backend())
        if not capture.isOpened():
            capture.release()
            raise CameraError(
                "The camera could not start",
                "No device answered at index {}. Try another index with --camera, "
                "or check that nothing else is holding the camera open.".format(index)
                + (
                    # Drawn with a Hershey font, which has nothing above ASCII:
                    # anything fancier reaches the user as question marks.
                    " On macOS, grant camera access to your terminal under "
                    "System Settings > Privacy & Security > Camera."
                    if platform.system() == "Darwin"
                    else ""
                ),
            )

        # Requests, not guarantees — the driver picks the nearest mode it has.
        capture.set(cv2.CAP_PROP_FRAME_WIDTH, width)
        capture.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
        capture.set(cv2.CAP_PROP_FPS, frame_rate)
        capture.set(cv2.CAP_PROP_BUFFERSIZE, 1)

        self._capture = capture
        self._stop.clear()
        self._thread = threading.Thread(target=self._pump, name="drawone-camera", daemon=True)
        self._thread.start()

        deadline = time.perf_counter() + FIRST_FRAME_TIMEOUT_S
        while self._latest() is None:
            if time.perf_counter() > deadline:
                self.stop()
                raise CameraError(
                    "The camera never sent a frame",
                    "It opened but stayed silent. Unplug and reconnect it, or pick "
                    "another camera with --camera.",
                )
            time.sleep(0.01)

        first = self._latest()
        assert first is not None
        actual_height, actual_width = first.image.shape[:2]
        reported_fps = capture.get(cv2.CAP_PROP_FPS)
        self._settings = CameraSettings(
            index=index,
            width=int(actual_width),
            height=int(actual_height),
            frame_rate=float(reported_fps) if reported_fps and reported_fps > 0 else 0.0,
        )

    def _pump(self) -> None:
        capture = self._capture
        if capture is None:
            return
        misses = 0
        while not self._stop.is_set():
            ok, image = capture.read()
            if not ok or image is None:
                misses += 1
                # A camera that has been unplugged reads `False` forever; back
                # off rather than spinning a core on it.
                time.sleep(0.005 if misses < 100 else 0.1)
                continue
            misses = 0
            with self._lock:
                self._counter += 1
                self._frame = Frame(self._counter, image, time.perf_counter())

    def _latest(self) -> Optional[Frame]:
        with self._lock:
            return self._frame

    def read(self) -> Optional[Frame]:
        """The newest frame, or None before the first one arrives."""
        return self._latest()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=1.0)
        self._thread = None
        if self._capture is not None:
            self._capture.release()
        self._capture = None
        with self._lock:
            self._frame = None
        self._settings = None

    @staticmethod
    def list_cameras(limit: int = 6) -> List[int]:
        """Probing means briefly opening each device, so this is called on demand
        rather than at startup.
        """
        found: List[int] = []
        with _quiet_backend():
            for index in range(limit):
                capture = cv2.VideoCapture(index, _backend())
                if capture.isOpened():
                    found.append(index)
                capture.release()
        return found


@contextlib.contextmanager
def _quiet_backend() -> Iterator[None]:
    """Mutes capture-backend chatter while probing.

    Every empty device index prints a failure the user did not ask about, and
    the loudest of them comes from the platform backend rather than OpenCV's
    logger, so the file descriptor has to go. Absence is reported by the return
    value, not by anything written here.
    """
    sys.stderr.flush()
    try:
        saved = os.dup(2)
        devnull = os.open(os.devnull, os.O_WRONLY)
    except OSError:
        yield
        return
    try:
        os.dup2(devnull, 2)
        yield
    finally:
        os.dup2(saved, 2)
        os.close(devnull)
        os.close(saved)
