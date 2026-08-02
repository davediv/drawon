"""Drawone — draw in the air, tracked by your webcam.

Kept import-light on purpose: the pure-logic modules (gesture, filter, mapper,
board) must be importable without OpenCV or MediaPipe so the tests can run
anywhere. Only `drawone.app` pulls in the heavy dependencies.
"""

__version__ = "1.0.0"
__all__ = ["__version__"]
