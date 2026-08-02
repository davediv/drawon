"""Exercises the pure logic of Drawone against synthetic input: gesture
classification, the pen trigger, the 1€ filter, coordinate mapping and the
board's action log.

Run it directly (`python3 tests/test_logic.py`) or under pytest.
"""

from __future__ import annotations

import math
import sys
from pathlib import Path
from typing import Dict, List, Sequence, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from drawone.board.board import Board  # noqa: E402
from drawone.lib.one_euro import OneEuroConfig, OneEuroFilter  # noqa: E402
from drawone.tracking.frame_mapper import FrameMapper  # noqa: E402
from drawone.tracking.gesture import PenTrigger, measure_hand, score_gesture  # noqa: E402
from drawone.tracking.landmarks import LM  # noqa: E402
from drawone.tracking.pointers import HandsFrame, PointerTracker, PointerUpdate  # noqa: E402
from drawone.types import Vec2, Vec3  # noqa: E402

failures = 0
checks = 0


def ok(label: str, condition: bool, detail: str = "") -> None:
    global failures, checks
    checks += 1
    suffix = "  ({})".format(detail) if detail else ""
    if condition:
        print("  PASS  {}{}".format(label, suffix))
    else:
        failures += 1
        print("  FAIL  {}{}".format(label, suffix))


def near(a: float, b: float, tol: float) -> bool:
    return abs(a - b) <= tol


# --- synthetic hand ---------------------------------------------------------


def finger(
    base: Vec3, lengths: Tuple[float, float, float], bends: Tuple[float, float]
) -> List[Vec3]:
    """Builds a finger chain that extends along -Y and curls toward +Z.

    Bending into Z means the XY projection collapses — the exact pose a 2D
    classifier reads as "still extended". `_curl_of` should report bend1 + bend2
    regardless.
    """
    dirs = [
        Vec3(0.0, -math.cos(math.radians(deg)), math.sin(math.radians(deg)))
        for deg in (0.0, bends[0], bends[0] + bends[1])
    ]

    points = [base]
    for i in range(3):
        prev = points[i]
        d = dirs[i]
        points.append(
            Vec3(
                prev.x + d.x * lengths[i],
                prev.y + d.y * lengths[i],
                prev.z + d.z * lengths[i],
            )
        )
    return points


def build_hand(spec: Dict[str, Tuple[float, float]]) -> List[Vec3]:
    lm: List[Vec3] = [Vec3(0.0, 0.0, 0.0)] * 21
    lm[LM.WRIST] = Vec3(0.0, 0.0, 0.0)

    # Knuckle row roughly 90 mm above the wrist — a real adult hand.
    mcps = {
        "index": Vec3(-0.022, -0.088, 0.0),
        "middle": Vec3(0.002, -0.09, 0.0),
        "ring": Vec3(0.024, -0.086, 0.0),
        "pinky": Vec3(0.044, -0.078, 0.0),
    }

    chains = (
        ("index", LM.INDEX_MCP, mcps["index"], (0.04, 0.025, 0.02)),
        ("middle", LM.MIDDLE_MCP, mcps["middle"], (0.045, 0.028, 0.021)),
        ("ring", LM.RING_MCP, mcps["ring"], (0.042, 0.026, 0.02)),
        ("pinky", LM.PINKY_MCP, mcps["pinky"], (0.033, 0.02, 0.018)),
    )

    for name, base_index, base, lengths in chains:
        points = finger(base, lengths, spec[name])
        for i in range(4):
            lm[base_index + i] = points[i]

    # Thumb splays out to the side rather than standing up with the fingers.
    thumb_points = finger(Vec3(-0.03, -0.02, 0.006), (0.033, 0.032, 0.026), spec["thumb"])

    def lean(p: Vec3, k: float) -> Vec3:
        return Vec3(p.x - k, p.y + k * 0.5, p.z)

    for i in range(4):
        lm[LM.THUMB_CMC + i] = lean(thumb_points[i], 0.012 * i)

    return lm


def main() -> int:
    # --- gesture ------------------------------------------------------------

    print("\nGesture geometry")

    open_hand = build_hand(
        {"thumb": (4, 4), "index": (3, 3), "middle": (3, 3), "ring": (3, 3), "pinky": (3, 3)}
    )
    open_metrics = measure_hand(open_hand)

    ok(
        "hand scale is a plausible adult hand",
        0.06 < open_metrics.hand_scale < 0.12,
        "{:.0f} mm".format(open_metrics.hand_scale * 1000),
    )
    ok(
        "an open hand reads as extended fingers",
        open_metrics.curls["index"] < 15 and open_metrics.curls["pinky"] < 15,
        "index curl {:.1f}deg".format(open_metrics.curls["index"]),
    )

    # _curl_of must recover the bend angles that built the finger.
    bent = build_hand(
        {"thumb": (4, 4), "index": (70, 55), "middle": (3, 3), "ring": (3, 3), "pinky": (3, 3)}
    )
    bent_metrics = measure_hand(bent)
    ok(
        "curl recovers the exact joint angles it was built from",
        near(bent_metrics.curls["index"], 125, 0.5),
        "expected 125deg, got {:.2f}deg".format(bent_metrics.curls["index"]),
    )

    # The pose that defeats an image-space classifier: the finger curls straight
    # at the camera, so its XY projection is nearly a single point.
    toward_camera = build_hand(
        {"thumb": (4, 4), "index": (88, 62), "middle": (3, 3), "ring": (3, 3), "pinky": (3, 3)}
    )
    tc_metrics = measure_hand(toward_camera)
    projected_2d = math.hypot(
        toward_camera[LM.INDEX_MCP].x - toward_camera[LM.INDEX_TIP].x,
        toward_camera[LM.INDEX_MCP].y - toward_camera[LM.INDEX_TIP].y,
    )
    ok(
        "a finger curled at the camera nearly vanishes in 2D",
        projected_2d < 0.03,
        "2D span only {:.1f} mm".format(projected_2d * 1000),
    )
    ok(
        "but 3D still reads it as folded",
        tc_metrics.curls["index"] > 140,
        "curl {:.1f}deg".format(tc_metrics.curls["index"]),
    )
    ok(
        "so point mode does not fire on it",
        score_gesture(tc_metrics, "point").score < 0.05,
        "score {:.3f}".format(score_gesture(tc_metrics, "point").score),
    )

    # Pinch: place the thumb tip on the index tip.
    pinch_hand = build_hand(
        {"thumb": (10, 10), "index": (35, 25), "middle": (3, 3), "ring": (3, 3), "pinky": (3, 3)}
    )
    tip = pinch_hand[LM.INDEX_TIP]
    pinch_hand[LM.THUMB_TIP] = Vec3(tip.x + 0.008, tip.y + 0.006, tip.z + 0.004)
    pinch_metrics = measure_hand(pinch_hand)

    ok(
        "a pinch scores high in pinch mode",
        score_gesture(pinch_metrics, "pinch").score > 0.9,
        "score {:.3f}, normalised gap {:.3f}".format(
            score_gesture(pinch_metrics, "pinch").score, pinch_metrics.pinch
        ),
    )
    ok(
        "an open hand scores zero in pinch mode",
        score_gesture(open_metrics, "pinch").score < 0.02,
        "score {:.3f}, gap {:.2f}".format(
            score_gesture(open_metrics, "pinch").score, open_metrics.pinch
        ),
    )

    pointing = build_hand(
        {"thumb": (20, 20), "index": (4, 4), "middle": (80, 60), "ring": (80, 60), "pinky": (80, 60)}
    )
    point_metrics = measure_hand(pointing)
    ok(
        "pointing scores high in point mode",
        score_gesture(point_metrics, "point").score > 0.9,
        "score {:.3f}".format(score_gesture(point_metrics, "point").score),
    )
    ok(
        "pointing does not fire pinch mode",
        score_gesture(point_metrics, "pinch").score < 0.05,
        "score {:.3f}".format(score_gesture(point_metrics, "pinch").score),
    )
    ok(
        "an open hand fires none of the modes",
        score_gesture(open_metrics, "any").score < 0.1,
        "best {} at {:.3f}".format(
            score_gesture(open_metrics, "any").name, score_gesture(open_metrics, "any").score
        ),
    )

    # Grip needs ring and pinky tucked away, so a bare pinch must not satisfy it.
    grip_hand = build_hand(
        {"thumb": (10, 10), "index": (35, 25), "middle": (40, 30), "ring": (80, 60), "pinky": (80, 60)}
    )
    grip_hand[LM.THUMB_TIP] = Vec3(
        grip_hand[LM.INDEX_TIP].x + 0.008,
        grip_hand[LM.INDEX_TIP].y + 0.006,
        grip_hand[LM.INDEX_TIP].z + 0.004,
    )
    ok(
        "a full pen grip scores high in grip mode",
        score_gesture(measure_hand(grip_hand), "grip").score > 0.9,
        "score {:.3f}".format(score_gesture(measure_hand(grip_hand), "grip").score),
    )
    ok(
        "a pinch with open fingers does not satisfy grip mode",
        score_gesture(pinch_metrics, "grip").score < 0.1,
        "score {:.3f}".format(score_gesture(pinch_metrics, "grip").score),
    )

    # --- trigger ------------------------------------------------------------

    print("\nPen trigger")

    trigger = PenTrigger()
    ok("starts up", not trigger.update(0.0))
    ok("one strong frame is not enough to engage", not trigger.update(0.99))
    ok("two consecutive strong frames engage", trigger.update(0.99))
    ok("reports the press edge exactly once", trigger.just_pressed)
    ok("stays down through a marginal frame", trigger.update(0.5))
    ok("does not re-report the press", not trigger.just_pressed)
    ok("one weak frame does not release", trigger.update(0.1))
    ok("two weak frames release", not trigger.update(0.1))
    ok("reports the release edge", trigger.just_released)

    # The Schmitt gap is the whole point: a score parked between the thresholds
    # must not toggle the pen on and off.
    trigger = PenTrigger()
    trigger.update(0.99)
    trigger.update(0.99)
    flips = 0
    previous = trigger.is_down
    for i in range(200):
        trigger.update(0.52 + math.sin(i) * 0.06)
        if trigger.is_down != previous:
            flips += 1
        previous = trigger.is_down
    ok(
        "a score hovering between thresholds never chatters",
        flips == 0,
        "{} flips over 200 frames".format(flips),
    )

    # --- 1€ filter ----------------------------------------------------------

    print("\nSmoothing")

    config = OneEuroConfig(min_cutoff=1.4, beta=0.012, derivative_cutoff=1.0)
    filtered = OneEuroFilter(config)

    # Deterministic pseudo-noise so the result is reproducible.
    seed = 12345

    def noise() -> float:
        nonlocal seed
        seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF
        return (seed / 0x7FFFFFFF - 0.5) * 12

    raw_spread = 0.0
    filtered_spread = 0.0
    for i in range(200):
        raw = 500 + noise()
        out = filtered.filter(raw, i / 60)
        if i > 60:
            raw_spread += abs(raw - 500)
            filtered_spread += abs(out - 500)
    ok(
        "a still fingertip is held steady against tracker jitter",
        filtered_spread < raw_spread * 0.35,
        "jitter cut to {:.0f}% of raw".format((filtered_spread / raw_spread) * 100),
    )

    # Same filter, now on a fast sweep: lag must stay small enough to feel attached.
    fast = OneEuroFilter(config)
    out = 0.0
    speed = 900  # board units per second, a brisk stroke
    for i in range(120):
        out = fast.filter((i / 60) * speed, i / 60)
    truth = (119 / 60) * speed
    lag_units = truth - out
    lag_ms = (lag_units / speed) * 1000
    ok(
        "a fast stroke stays under the 50 ms latency budget",
        lag_ms < 50,
        "{:.1f} ms of filter lag at {} units/s".format(lag_ms, speed),
    )

    # --- coordinate mapping -------------------------------------------------

    print("\nCoordinate mapping")

    mapper = FrameMapper()
    # A 16:9 camera in a taller-than-wide stage: cover crops top and bottom.
    mapper.configure(1280, 720, 1600, 1000, True)

    centre = mapper.normalized_to_stage(0.5, 0.5)
    ok(
        "the frame centre lands at the stage centre",
        near(centre.x, 800, 0.01) and near(centre.y, 500, 0.01),
        "({:.1f}, {:.1f})".format(centre.x, centre.y),
    )

    left = mapper.normalized_to_stage(0.2, 0.5)
    ok("mirroring flips left to right", left.x > centre.x, "x {:.1f} vs centre 800".format(left.x))

    mapper.configure(1280, 720, 1600, 1000, False)
    unmirrored = mapper.normalized_to_stage(0.2, 0.5)
    ok(
        "unmirrored keeps left on the left",
        unmirrored.x < centre.x and near(unmirrored.x + left.x, 1600, 0.01),
        "x {:.1f}".format(unmirrored.x),
    )

    ok(
        "board space is isotropic",
        near(mapper.board_width, (1280 / 720) * 1000, 0.01),
        "board width {:.1f}".format(mapper.board_width),
    )

    # Resizing must move ink with the frame, not distort it.
    small = FrameMapper()
    small.configure(1280, 720, 800, 500, False)
    large = FrameMapper()
    large.configure(1280, 720, 1600, 1000, False)
    a1 = small.normalized_to_stage(0.3, 0.7)
    a2 = small.normalized_to_stage(0.6, 0.2)
    b1 = large.normalized_to_stage(0.3, 0.7)
    b2 = large.normalized_to_stage(0.6, 0.2)
    ratio_x = (b2.x - b1.x) / (a2.x - a1.x)
    ratio_y = (b2.y - b1.y) / (a2.y - a1.y)
    ok(
        "doubling the stage scales ink uniformly",
        near(ratio_x, 2, 0.001) and near(ratio_y, 2, 0.001),
        "x {:.4f}, y {:.4f}".format(ratio_x, ratio_y),
    )

    # --- board --------------------------------------------------------------

    print("\nBoard history")

    board = Board()
    board.resize(1280, 720)

    board.begin_stroke(1, "pen", "#ff0000", 8, Vec2(100, 100))
    board.extend_stroke(1, Vec2(140, 100))
    board.extend_stroke(1, Vec2(180, 100))
    board.end_stroke(1)
    ok("a finished stroke lands in history", board.stats.strokes == 1)

    board.begin_stroke(1, "pen", "#00ff00", 8, Vec2(200, 200))
    board.extend_stroke(1, Vec2(240, 200))
    board.end_stroke(1)
    ok("two strokes recorded", board.stats.strokes == 2)

    board.undo()
    ok("undo removes the last stroke", board.stats.strokes == 1)
    ok("undo enables redo", board.stats.can_redo)
    board.redo()
    ok("redo restores it", board.stats.strokes == 2)

    board.clear()
    ok("clear leaves nothing drawable", board.stats.strokes == 0)
    ok("but clear is itself undoable", board.stats.can_undo)
    board.undo()
    ok(
        "undoing a clear brings the drawing back",
        board.stats.strokes == 2,
        "{} strokes".format(board.stats.strokes),
    )

    # A new action must invalidate the redo branch.
    board.undo()
    board.begin_stroke(2, "pen", "#0000ff", 8, Vec2(10, 10))
    board.end_stroke(2)
    ok("drawing after an undo drops the redo branch", not board.stats.can_redo)

    board = Board()
    board.resize(1280, 720)
    board.begin_stroke(1, "pen", "#fff", 8, Vec2(100, 100))
    # Samples closer than the decimation threshold should be dropped.
    for i in range(50):
        board.extend_stroke(1, Vec2(100 + i * 0.2, 100))
    decimated = len(list(board.active_strokes)[0].points)
    ok(
        "sub-pixel jitter samples are decimated away",
        decimated < 8,
        "{} points kept from 51".format(decimated),
    )

    # A teleport means the tracker re-acquired; the stroke must not bridge it.
    accepted = board.extend_stroke(1, Vec2(900, 700))
    ok("a tracking jump is rejected rather than drawn across", not accepted)

    # Two hands must not share stroke state.
    board = Board()
    board.resize(1280, 720)
    board.begin_stroke(1, "pen", "#f00", 8, Vec2(100, 100))
    board.begin_stroke(2, "pen", "#0f0", 8, Vec2(600, 100))
    board.extend_stroke(1, Vec2(200, 100))
    board.extend_stroke(2, Vec2(700, 100))
    strokes = list(board.active_strokes)
    ok("both hands draw at once", len(strokes) == 2)
    ok(
        "each hand keeps its own colour and points",
        strokes[0].color == "#f00"
        and strokes[1].color == "#0f0"
        and strokes[0].points[1].x == 200
        and strokes[1].points[1].x == 700,
    )
    board.end_stroke(1)
    ok("closing one hand leaves the other drawing", len(list(board.active_strokes)) == 1)

    # --- pointer identity ---------------------------------------------------

    print("\nPointer tracking")

    mapper = FrameMapper()
    mapper.configure(1280, 720, 1280, 720, False)

    def image_hand(wrist_x: float, tip_x: float, tip_y: float) -> List[Vec3]:
        """Normalised image landmarks; only the wrist and index tip matter here."""
        return [
            Vec3(tip_x if i == LM.INDEX_TIP else wrist_x, tip_y if i == LM.INDEX_TIP else 0.8, 0.0)
            for i in range(21)
        ]

    def result(hands: Sequence[Tuple[float, float, float, List[Vec3]]]) -> HandsFrame:
        return HandsFrame(
            landmarks=[image_hand(h[0], h[1], h[2]) for h in hands],
            world=[h[3] for h in hands],
            handedness=["Right"] * len(hands),
        )

    def opts(frame: int) -> PointerUpdate:
        return PointerUpdate(
            mapper=mapper, gesture_mode="pinch", smoothing=0.5, time=frame / 60, frame=frame
        )

    pinch_world = pinch_hand
    open_world = open_hand

    tracker = PointerTracker()
    frame = 1
    last = tracker.update(result([(0.4, 0.5, 0.5, pinch_world)]), opts(frame))
    ok("a detected hand yields one pointer", len(last) == 1)
    ok("the pen is not down on the very first frame", not last[0].is_down)

    frame += 1
    last = tracker.update(result([(0.4, 0.5, 0.5, pinch_world)]), opts(frame))
    ok("a held pinch brings the pen down", last[0].is_down)

    # 0.5 normalised x on a 16:9 frame is half of 1777.8 board units.
    ok(
        "the nib tracks the index fingertip in board units",
        near(last[0].tip.x, 888.9, 60) and near(last[0].tip.y, 500, 60),
        "({:.0f}, {:.0f})".format(last[0].tip.x, last[0].tip.y),
    )

    frame += 1
    last = tracker.update(result([(0.4, 0.5, 0.5, open_world)]), opts(frame))
    frame += 1
    last = tracker.update(result([(0.4, 0.5, 0.5, open_world)]), opts(frame))
    ok("opening the hand lifts the pen", not last[0].is_down)

    tracker = PointerTracker()
    frame = 0

    def two_hands(swap: bool) -> HandsFrame:
        a = (0.25, 0.25, 0.5, pinch_world)
        b = (0.75, 0.75, 0.5, open_world)
        return result([b, a] if swap else [a, b])

    frame += 1
    out = tracker.update(two_hands(False), opts(frame))
    ok("two hands yield two pointers", len(out) == 2)
    left_id = next(p for p in out if p.tip.x < 800).id
    right_id = next(p for p in out if p.tip.x > 800).id
    ok("the two hands get distinct identities", left_id != right_id)

    # MediaPipe gives no ordering guarantee — identity must survive a reorder.
    frame += 1
    out = tracker.update(two_hands(True), opts(frame))
    ok(
        "identity follows position, not array order",
        next(p for p in out if p.tip.x < 800).id == left_id
        and next(p for p in out if p.tip.x > 800).id == right_id,
    )

    # A hand leaving must eventually retire so its stroke gets closed. `retired`
    # is per-frame, so it has to be collected as it happens.
    retirements: List[int] = []
    frames_until_retired = 0
    for _ in range(8):
        frame += 1
        out = tracker.update(result([(0.75, 0.75, 0.5, open_world)]), opts(frame))
        if not retirements:
            frames_until_retired += 1
        retirements.extend(tracker.retired)
    ok(
        "a hand that leaves the frame is retired",
        left_id in retirements,
        "after {} absent frames (~{} ms)".format(
            frames_until_retired, round((frames_until_retired / 60) * 1000)
        ),
    )
    ok(
        "the remaining hand keeps its identity",
        len(out) == 1 and out[0].id == right_id,
    )

    # A one-frame detection blip must not split a stroke in two.
    tracker = PointerTracker()
    frame = 0
    present = result([(0.4, 0.5, 0.5, pinch_world)])
    frame += 1
    tracker.update(present, opts(frame))
    frame += 1
    pointer_id = tracker.update(present, opts(frame))[0].id
    frame += 1
    tracker.update(HandsFrame(), opts(frame))
    ok("a single dropped frame does not retire the hand", len(tracker.retired) == 0)
    frame += 1
    back = tracker.update(present, opts(frame))
    ok("the hand resumes with the same identity", back[0].id == pointer_id)
    ok("and the pen never lifted", back[0].is_down)

    print("\n{}/{} checks passed".format(checks - failures, checks))
    if failures > 0:
        print("{} FAILED".format(failures))
    return 1 if failures else 0


def test_logic() -> None:
    """pytest entry point."""
    assert main() == 0, "{} logic checks failed".format(failures)


if __name__ == "__main__":
    raise SystemExit(main())
