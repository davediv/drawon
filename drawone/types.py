"""Value types shared across the app."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import ClassVar, List, Literal, NamedTuple, Union


class Vec2(NamedTuple):
    x: float
    y: float


class Vec3(NamedTuple):
    x: float
    y: float
    z: float


Tool = Literal["pen", "eraser"]

# How the app decides you are "holding a pen".
#   pinch : thumb tip and index tip touch (stylus grip)
#   point : index extended, other fingers curled
#   grip  : pinch *and* ring + pinky curled — strictest, fewest false starts
#   any   : whichever of the above fires first
GestureMode = Literal["pinch", "point", "grip", "any"]

# Stroke points live in aspect-corrected camera space, not screen pixels, so a
# window resize re-maps the artwork instead of distorting it. See `FrameMapper`.
BoardPoint = Vec2


@dataclass
class StrokeAction:
    tool: Tool
    color: str
    #: Width in board units (1000 = full camera-frame height).
    width: float
    points: List[BoardPoint] = field(default_factory=list)

    kind: ClassVar[str] = "stroke"


@dataclass
class ClearAction:
    kind: ClassVar[str] = "clear"


BoardAction = Union[StrokeAction, ClearAction]
