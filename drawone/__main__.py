"""Command line entry point: `python -m drawone`."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .config import CAMERA


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="drawone",
        description="Draw in the air. Your webcam tracks your hand, a pen-holding "
        "gesture puts the pen down, and your index fingertip inks onto a "
        "transparent canvas laid over the video.",
    )
    parser.add_argument("--camera", type=int, default=None, help="camera index (default: remembered, else 0)")
    parser.add_argument("--width", type=int, default=CAMERA.ideal_width, help="requested capture width")
    parser.add_argument("--height", type=int, default=CAMERA.ideal_height, help="requested capture height")
    parser.add_argument("--fps", type=int, default=CAMERA.ideal_frame_rate, help="requested capture frame rate")
    parser.add_argument("--model", type=Path, default=None, help="path to hand_landmarker.task")
    parser.add_argument("--out", type=Path, default=Path.cwd(), help="directory for saved PNGs")
    parser.add_argument("--cpu", action="store_true", help="skip the GPU delegate")
    mirror = parser.add_mutually_exclusive_group()
    mirror.add_argument("--mirror", dest="mirror", action="store_true", default=None,
                        help="force the selfie view on")
    mirror.add_argument("--no-mirror", dest="mirror", action="store_false",
                        help="force the selfie view off")
    parser.add_argument("--list-cameras", action="store_true", help="print available camera indices and exit")
    return parser


def main(argv: "list[str] | None" = None) -> int:
    args = build_parser().parse_args(argv)

    try:
        import cv2  # noqa: F401
        import mediapipe  # noqa: F401
    except ImportError as error:
        print(
            "Drawone needs OpenCV and MediaPipe:\n"
            "    pip install -r requirements.txt\n"
            "({})".format(error),
            file=sys.stderr,
        )
        return 1

    from .app import App, AppOptions
    from .tracking.camera import Camera

    if args.list_cameras:
        found = Camera.list_cameras()
        print("Cameras: {}".format(", ".join(str(i) for i in found)) if found else "No cameras found")
        return 0

    return App(
        AppOptions(
            camera=args.camera,
            width=args.width,
            height=args.height,
            frame_rate=args.fps,
            model=args.model,
            out_dir=args.out,
            prefer_gpu=not args.cpu,
            mirror=args.mirror,
        )
    ).run()


if __name__ == "__main__":
    raise SystemExit(main())
