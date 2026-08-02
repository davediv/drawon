"""The loop, the wiring and the layout."""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional

import cv2
import numpy as np

from .board.board import Board
from .board.export import ExportMode, export_png, timestamped_name
from .config import CAMERA
from .lib.maths import Ema
from .render.canvas import Layer, composite_over
from .render.overlay import OverlayOptions, OverlayRenderer
from .tracking.camera import Camera, CameraError, Frame
from .tracking.frame_mapper import FrameMapper
from .tracking.hand_tracker import HandTracker
from .tracking.pointers import HandPointer, PointerTracker, PointerUpdate
from .ui.controls import ControlHandlers, Controls, GateContent
from .ui.hud import Hud, HudReading
from .ui.settings import Settings

WINDOW = "Drawone"

#: Ceiling for re-drawing an unchanged camera frame. Between captures the only
#: things that move are UI animations, and they do not need more than this.
PRESENT_INTERVAL = 1.0 / 60.0


@dataclass
class AppOptions:
    camera: Optional[int] = None
    width: int = CAMERA.ideal_width
    height: int = CAMERA.ideal_height
    frame_rate: int = CAMERA.ideal_frame_rate
    model: Optional[Path] = None
    out_dir: Path = field(default_factory=Path.cwd)
    prefer_gpu: bool = True
    mirror: Optional[bool] = None


class App:
    def __init__(self, options: Optional[AppOptions] = None) -> None:
        self.options = options or AppOptions()

        self.camera = Camera()
        self.tracker = HandTracker()
        self.pointers = PointerTracker()
        self.mapper = FrameMapper()
        self.board = Board()
        self.overlay = OverlayRenderer()
        self.hud = Hud()
        self.controls = Controls(
            ControlHandlers(
                on_settings_change=self._on_settings_change,
                on_undo=self.board.undo,
                on_redo=self.board.redo,
                on_clear=self._clear,
                on_save=self._save,
                on_next_camera=self._next_camera,
                on_quit=lambda: None,
            )
        )

        if self.options.camera is not None:
            self.controls.settings.camera_id = int(self.options.camera)
        if self.options.mirror is not None:
            self.controls.settings.mirror = bool(self.options.mirror)

        self.board.on_change = self.controls.set_history
        self.controls.set_history(self.board.stats)

        self._fps = Ema(0.1)
        self._track = Ema(0.1)
        self._pipe = Ema(0.1)

        self._overlay_layer = Layer(1, 1)
        self._display: Optional[np.ndarray] = None
        self._last_frame_id = -1
        self._frame_index = 0
        self._last_frame_time = 0.0
        self._last_present = 0.0
        self._pointers: List[HandPointer] = []
        self._running = False
        self._cameras: List[int] = []

    # ---- lifecycle --------------------------------------------------------

    def run(self) -> int:
        cv2.namedWindow(WINDOW, cv2.WINDOW_NORMAL | cv2.WINDOW_KEEPRATIO)
        cv2.resizeWindow(WINDOW, self.options.width, self.options.height)

        try:
            self._start()
            self._running = True
            while self._running:
                self._step()
                if not self._pump_events():
                    break
                if cv2.getWindowProperty(WINDOW, cv2.WND_PROP_VISIBLE) < 1:
                    break
        finally:
            self.stop()
            cv2.destroyAllWindows()
        return 0

    def _start(self) -> None:
        settings = self.controls.settings

        self._show_gate(
            "busy", "Starting up", "Waiting for the camera.", fine="Video never leaves this machine"
        )
        try:
            self.camera.start(
                settings.camera_id,
                self.options.width,
                self.options.height,
                self.options.frame_rate,
            )

            if not self.tracker.ready:
                self._show_gate(
                    "busy", "Starting up", "Loading the hand model - about 8 MB, once."
                )
                self.tracker.load(
                    self.options.model,
                    on_progress=lambda message: self._show_gate(
                        "busy", "Starting up", message + "..."
                    ),
                    prefer_gpu=self.options.prefer_gpu,
                )

            self.controls.set_gate("hidden")
            self._update_meta()
        except (CameraError, FileNotFoundError, RuntimeError) as error:
            self.stop()
            title = getattr(error, "message", "Setup failed")
            hint = getattr(error, "hint", str(error))
            self.controls.set_gate(
                "error",
                GateContent(
                    title=title, body=hint, action="Press N to try the next camera, Q to quit"
                ),
            )

    def stop(self) -> None:
        self.board.end_all_strokes()
        self.pointers.reset()
        self._pointers = []
        self.camera.stop()
        self.hud.reset()

    # ---- frame ------------------------------------------------------------

    def _step(self) -> None:
        frame = self.camera.read()
        fresh = frame is not None and frame.id != self._last_frame_id

        if fresh:
            self._last_frame_id = frame.id
            try:
                self._track_frame(frame)
            except Exception as error:  # one bad frame must not end the session
                print("Frame failed: {}".format(error))

        now = time.perf_counter()
        if fresh or now - self._last_present >= PRESENT_INTERVAL:
            self._last_present = now
            self._present(frame, fresh)

    def _track_frame(self, frame: Frame) -> None:
        now = time.perf_counter()
        if self._last_frame_time > 0:
            delta = now - self._last_frame_time
            if 0 < delta < 0.5:
                self._fps.push(1.0 / delta)
        self._last_frame_time = now

        height, width = frame.image.shape[:2]
        if self.mapper.video_width != width or self.mapper.video_height != height:
            self._sync_layout(width, height)
            self._update_meta()

        started = time.perf_counter()
        result = self.tracker.detect(frame.image, frame.captured_at * 1000.0)
        self._track.push((time.perf_counter() - started) * 1000.0)

        self._frame_index += 1
        settings = self.controls.settings
        self._pointers = self.pointers.update(
            result,
            PointerUpdate(
                mapper=self.mapper,
                gesture_mode=settings.gesture_mode,
                smoothing=settings.smoothing,
                time=frame.captured_at,
                frame=self._frame_index,
            ),
        )

        for pointer_id in self.pointers.retired:
            self.board.end_stroke(pointer_id)
        for pointer in self._pointers:
            self._apply_pointer(pointer)

    def _apply_pointer(self, pointer: HandPointer) -> None:
        """Translates one hand's pen state into stroke mutations."""
        settings = self.controls.settings
        width = self.controls.active_width

        if not pointer.is_down:
            self.board.end_stroke(pointer.id)
            return

        if not self.board.has_active_stroke(pointer.id):
            self.board.begin_stroke(
                pointer.id, settings.tool, settings.color, width, pointer.tip
            )
            return

        if not self.board.extend_stroke(pointer.id, pointer.tip):
            # The sample was too far from the last one to be the same movement.
            # Close the stroke and start a fresh one at the new position.
            self.board.end_stroke(pointer.id)
            self.board.begin_stroke(
                pointer.id, settings.tool, settings.color, width, pointer.tip
            )

    def _present(self, frame: Optional[Frame], fresh: bool = True) -> None:
        settings = self.controls.settings
        display = self._compose_base(frame)
        height, width = display.shape[:2]

        if self.mapper.stage_width != width or self.mapper.stage_height != height:
            self._sync_layout(width, height)

        composite_over(display, self.board.render(self.mapper, width, height))

        self._overlay_layer.resize(width, height)
        self.overlay.render(
            self._overlay_layer,
            self.mapper,
            self._pointers,
            OverlayOptions(
                show_skeleton=settings.show_skeleton,
                tool=settings.tool,
                color=settings.color,
                brush=self.controls.active_width,
                now=time.perf_counter() * 1000.0,
            ),
        )
        composite_over(display, self._overlay_layer)

        scale = max(height / 720.0, 0.62)
        self.hud.update(
            HudReading(
                state="inking" if self.board.has_active_strokes else "live",
                fps=self._fps.current,
                track_ms=self._track.current,
                pipe_ms=self._pipe.current,
                hands=len(self._pointers),
            ),
            time.perf_counter() * 1000.0,
        )
        if self.controls.gate_state == "hidden":
            self.hud.render(display, scale)
        self.controls.render(display, scale)

        # Capture to ink, measured only on frames that actually carried new
        # tracking — re-presenting a frame for an animation says nothing about
        # pipeline latency and would just inflate the reading.
        if fresh and frame is not None:
            pipe = (time.perf_counter() - frame.captured_at) * 1000.0
            if 0 <= pipe < 500:
                self._pipe.push(pipe)

        cv2.imshow(WINDOW, display)

    def _compose_base(self, frame: Optional[Frame]) -> np.ndarray:
        settings = self.controls.settings

        if frame is None:
            return self._blank()

        if not settings.show_video:
            base = np.zeros_like(frame.image)
        elif settings.mirror:
            base = cv2.flip(frame.image, 1)
        else:
            # A copy either way: the interface is painted onto this buffer, and
            # the same frame is re-presented until the camera delivers a new one.
            base = frame.image.copy()
        return base

    def _blank(self) -> np.ndarray:
        if self._display is None or self._display.shape[0] != self.options.height:
            self._display = np.zeros((self.options.height, self.options.width, 3), np.uint8)
        self._display[:] = 0
        return self._display

    def _pump_events(self) -> bool:
        key = cv2.waitKeyEx(1)
        return self.controls.handle_key(key)

    # ---- layout -----------------------------------------------------------

    def _sync_layout(self, width: int, height: int) -> None:
        settings = self.controls.settings
        video_width = self.camera.settings.width if self.camera.settings else width
        video_height = self.camera.settings.height if self.camera.settings else height
        self.mapper.configure(video_width, video_height, width, height, settings.mirror)
        self.board.resize(width, height)
        self.board.invalidate()
        self._overlay_layer.resize(width, height)

    def _update_meta(self) -> None:
        settings = self.camera.settings
        if settings is None:
            self.hud.set_meta("")
            return
        fps = "  {}fps".format(round(settings.frame_rate)) if settings.frame_rate else ""
        self.hud.set_meta(
            "{}x{}{}  {}".format(settings.width, settings.height, fps, self.tracker.delegate)
        )

    # ---- actions ----------------------------------------------------------

    def _clear(self) -> None:
        if self.board.stats.strokes == 0:
            return
        self.board.clear()
        self.controls.toast("Board cleared - undo with Z")

    def _save(self, mode: ExportMode) -> None:
        if self.board.stats.strokes == 0:
            self.controls.toast("Nothing to save yet")
            return

        frame = self.camera.read()
        settings = self.camera.settings
        try:
            self.board.end_all_strokes()
            path = export_png(
                Path(self.options.out_dir) / timestamped_name(mode),
                self.board.get_actions(),
                settings.width if settings else self.mapper.stage_width,
                settings.height if settings else self.mapper.stage_height,
                self.controls.settings.mirror,
                mode,
                frame.image if frame is not None else None,
            )
            self.controls.toast("Saved {}".format(path.name))
            print("Saved {}".format(path))
        except Exception as error:
            print("Export failed: {}".format(error))
            self.controls.toast("The image could not be saved")

    def _next_camera(self) -> None:
        if not self._cameras:
            self.controls.toast("Looking for cameras...")
            self._cameras = Camera.list_cameras()
        if len(self._cameras) < 2:
            self.controls.toast("No other camera found")
            return

        current = self.controls.settings.camera_id
        index = self._cameras.index(current) if current in self._cameras else -1
        self.controls.settings.camera_id = self._cameras[(index + 1) % len(self._cameras)]
        self._restart_camera()

    def _restart_camera(self) -> None:
        self.board.end_all_strokes()
        self.pointers.reset()
        self._pointers = []
        self.camera.stop()
        self._last_frame_id = -1
        try:
            self.camera.start(
                self.controls.settings.camera_id,
                self.options.width,
                self.options.height,
                self.options.frame_rate,
            )
            self.controls.set_gate("hidden")
            self._update_meta()
            self.controls.toast("Camera {}".format(self.controls.settings.camera_id))
        except CameraError as error:
            self.controls.set_gate(
                "error",
                GateContent(
                    title=error.message,
                    body=error.hint,
                    action="Press N to try the next camera, Q to quit",
                ),
            )

    def _on_settings_change(self, settings: Settings, key: str) -> None:
        if key == "mirror":
            # Ink is stored in camera space, so flipping the view re-projects the
            # existing drawing rather than leaving it stranded.
            self._sync_layout(self.mapper.stage_width, self.mapper.stage_height)
        elif key == "gesture_mode":
            self.board.end_all_strokes()
            self.pointers.reset()
        elif key == "camera_id":
            self._restart_camera()

    # ---- gate -------------------------------------------------------------

    def _show_gate(self, state: str, title: str, body: str, fine: str = "") -> None:
        """Paints a gate frame immediately — the calls behind it block."""
        self.controls.set_gate(state, GateContent(title=title, body=body, fine=fine))
        display = self._blank()
        scale = max(display.shape[0] / 720.0, 0.62)
        self.controls.render(display, scale)
        cv2.imshow(WINDOW, display)
        cv2.waitKey(1)
