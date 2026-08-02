"""1€ filter (Casiez, Roussel & Vogel, CHI 2012).

A plain low-pass filter forces a choice between jitter and lag. This one adapts
its cutoff to speed: it filters hard while the hand is nearly still (killing
tracker jitter) and opens up as the hand accelerates (so fast strokes stay
latency-free). That property is the reason air-drawing feels attached to your
fingertip instead of dragging behind it.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional

from ..types import Vec2


def _alpha_for(cutoff_hz: float, dt: float) -> float:
    tau = 1.0 / (2.0 * math.pi * cutoff_hz)
    return 1.0 / (1.0 + tau / dt)


class _LowPass:
    def __init__(self) -> None:
        self._state: Optional[float] = None

    def filter(self, value: float, alpha: float) -> float:
        self._state = (
            value if self._state is None else alpha * value + (1 - alpha) * self._state
        )
        return self._state

    @property
    def has_value(self) -> bool:
        return self._state is not None

    def reset(self) -> None:
        self._state = None


@dataclass(frozen=True)
class OneEuroConfig:
    #: Cutoff at zero speed, in Hz. Lower = steadier, but laggier.
    min_cutoff: float
    #: How aggressively the cutoff opens with speed. Higher = less lag.
    beta: float
    #: Cutoff for the derivative estimate itself.
    derivative_cutoff: float = 1.0


class OneEuroFilter:
    def __init__(self, config: OneEuroConfig) -> None:
        self._config = config
        self._value = _LowPass()
        self._derivative = _LowPass()
        self._last_value = 0.0
        self._last_time: Optional[float] = None

    def configure(self, config: OneEuroConfig) -> None:
        self._config = config

    def filter(self, value: float, time: float) -> float:
        """`time` is in seconds, monotonic."""
        if self._last_time is None:
            self._last_time = time
            self._last_value = value
            return self._value.filter(value, 1.0)

        # Guard against duplicate timestamps and against a stalled process
        # producing a huge dt, which would otherwise make alpha ~1 and pass
        # jitter straight through.
        dt = min(max(time - self._last_time, 1.0 / 240.0), 1.0 / 5.0)
        self._last_time = time

        speed = (value - self._last_value) / dt
        self._last_value = value

        smoothed_speed = self._derivative.filter(
            speed, _alpha_for(self._config.derivative_cutoff, dt)
        )

        cutoff = self._config.min_cutoff + self._config.beta * abs(smoothed_speed)
        return self._value.filter(value, _alpha_for(cutoff, dt))

    def reset(self) -> None:
        self._value.reset()
        self._derivative.reset()
        self._last_time = None
        self._last_value = 0.0


class OneEuroPoint:
    """Two independent 1€ filters, for a 2D point."""

    def __init__(self, config: OneEuroConfig) -> None:
        self._fx = OneEuroFilter(config)
        self._fy = OneEuroFilter(config)

    def configure(self, config: OneEuroConfig) -> None:
        self._fx.configure(config)
        self._fy.configure(config)

    def filter(self, x: float, y: float, time: float) -> Vec2:
        return Vec2(self._fx.filter(x, time), self._fy.filter(y, time))

    def reset(self) -> None:
        self._fx.reset()
        self._fy.reset()
