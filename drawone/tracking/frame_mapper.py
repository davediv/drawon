"""Coordinate spaces.

Converts between the three spaces in play:

  normalized  — what MediaPipe returns, 0..1 across the camera frame
  board       — where strokes are stored: isotropic, y spans 0..1000 over the
                camera frame height, x spans 0..1000*aspect
  stage       — pixels in the window, after cover-fit and mirroring

Strokes are stored in board space rather than pixels so that resizing the window
re-projects the artwork instead of stretching or discarding it, and so that a PNG
can be exported at the camera's native resolution.
"""

from __future__ import annotations

from ..config import BOARD_HEIGHT
from ..types import Vec2


class FrameMapper:
    def __init__(self) -> None:
        self.video_width = 0
        self.video_height = 0
        self.stage_width = 0
        self.stage_height = 0
        self.mirrored = True

        #: Stage pixels per board unit.
        self._k = 1.0
        self._origin_x = 0.0
        self._origin_y = 0.0

    @property
    def ready(self) -> bool:
        return self.video_width > 0 and self.video_height > 0 and self.stage_width > 0

    @property
    def board_width(self) -> float:
        """Board-space width of the visible frame (height is always BOARD_HEIGHT)."""
        if self.video_height > 0:
            return (self.video_width / self.video_height) * BOARD_HEIGHT
        return BOARD_HEIGHT

    @property
    def pixels_per_unit(self) -> float:
        """Stage pixels per board unit — use it to convert stroke widths."""
        return self._k

    def configure(
        self,
        video_width: int,
        video_height: int,
        stage_width: int,
        stage_height: int,
        mirrored: bool,
    ) -> None:
        self.video_width = video_width
        self.video_height = video_height
        self.stage_width = stage_width
        self.stage_height = stage_height
        self.mirrored = mirrored

        if not self.ready:
            self._k = 1.0
            self._origin_x = 0.0
            self._origin_y = 0.0
            return

        # Cover fit — scale so the frame fills the stage, overflow is cropped.
        scale = max(stage_width / video_width, stage_height / video_height)
        display_width = video_width * scale
        display_height = video_height * scale

        self._k = display_height / BOARD_HEIGHT
        self._origin_x = (stage_width - display_width) / 2
        self._origin_y = (stage_height - display_height) / 2

    def normalized_to_board(self, nx: float, ny: float) -> Vec2:
        """Normalized MediaPipe coordinates to board space."""
        return Vec2(nx * self.board_width, ny * BOARD_HEIGHT)

    def board_to_stage(self, bx: float, by: float) -> Vec2:
        x = self._origin_x + bx * self._k
        return Vec2(
            self.stage_width - x if self.mirrored else x,
            self._origin_y + by * self._k,
        )

    def normalized_to_stage(self, nx: float, ny: float) -> Vec2:
        b = self.normalized_to_board(nx, ny)
        return self.board_to_stage(b.x, b.y)


def export_mapper(video_width: int, video_height: int, mirrored: bool) -> FrameMapper:
    """A mapper that renders board space 1:1 into a bitmap of the given size —
    used for PNG export, where there is no cropping and no stage.
    """
    mapper = FrameMapper()
    mapper.configure(video_width, video_height, video_width, video_height, mirrored)
    return mapper
