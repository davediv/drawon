/**
 * Exercises the pure logic of Drawone against synthetic input: gesture
 * classification, the pen trigger, the 1€ filter, coordinate mapping and the
 * board's action log. Bundled with esbuild and run on Node.
 */
import { measureHand, PenTrigger, scoreGesture } from '../src/tracking/gesture';
import { OneEuroFilter } from '../src/lib/oneEuro';
import { FrameMapper } from '../src/tracking/frameMapper';
import { Board } from '../src/board/board';
import { LM } from '../src/tracking/landmarks';
import { PointerTracker } from '../src/tracking/pointers';
import type { Vec3 } from '../src/types';

// Board rasterises into an offscreen canvas. Only its action-log semantics are
// under test here, so the drawing surface is a no-op stub.
const stubContext = new Proxy(
  {},
  {
    get: (target: Record<string, unknown>, key: string) => {
      if (key in target) return target[key];
      return () => undefined;
    },
    set: (target: Record<string, unknown>, key: string, value: unknown) => {
      target[key] = value;
      return true;
    },
  },
);
(globalThis as unknown as { document: unknown }).document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => stubContext }),
};

// Declared rather than pulling in @types/node for one call.
declare const process: { exit(code: number): never };

let failures = 0;
let checks = 0;

function ok(label: string, condition: boolean, detail = ''): void {
  checks += 1;
  if (condition) {
    console.log(`  PASS  ${label}${detail ? `  (${detail})` : ''}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ''}`);
  }
}

const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;

// --- synthetic hand ---------------------------------------------------------

const DEG = Math.PI / 180;

/**
 * Builds a finger chain that extends along -Y and curls toward +Z. Bending into
 * Z means the XY projection collapses — the exact pose a 2D classifier reads as
 * "still extended". `curlOf` should report bend1 + bend2 regardless.
 */
function finger(base: Vec3, lengths: [number, number, number], bends: [number, number]): Vec3[] {
  const dirs = [0, bends[0], bends[0] + bends[1]].map((deg) => ({
    x: 0,
    y: -Math.cos(deg * DEG),
    z: Math.sin(deg * DEG),
  }));

  const points: Vec3[] = [base];
  for (let i = 0; i < 3; i += 1) {
    const prev = points[i];
    const d = dirs[i];
    points.push({
      x: prev.x + d.x * lengths[i],
      y: prev.y + d.y * lengths[i],
      z: prev.z + d.z * lengths[i],
    });
  }
  return points;
}

interface HandSpec {
  thumb: [number, number];
  index: [number, number];
  middle: [number, number];
  ring: [number, number];
  pinky: [number, number];
}

function buildHand(spec: HandSpec): Vec3[] {
  const lm: Vec3[] = new Array(21);
  lm[LM.WRIST] = { x: 0, y: 0, z: 0 };

  // Knuckle row roughly 90 mm above the wrist — a real adult hand.
  const mcps: Record<string, Vec3> = {
    index: { x: -0.022, y: -0.088, z: 0 },
    middle: { x: 0.002, y: -0.09, z: 0 },
    ring: { x: 0.024, y: -0.086, z: 0 },
    pinky: { x: 0.044, y: -0.078, z: 0 },
  };

  const chains: Array<[keyof HandSpec, number, Vec3, [number, number, number]]> = [
    ['index', LM.INDEX_MCP, mcps.index, [0.04, 0.025, 0.02]],
    ['middle', LM.MIDDLE_MCP, mcps.middle, [0.045, 0.028, 0.021]],
    ['ring', LM.RING_MCP, mcps.ring, [0.042, 0.026, 0.02]],
    ['pinky', LM.PINKY_MCP, mcps.pinky, [0.033, 0.02, 0.018]],
  ];

  for (const [name, baseIndex, base, lengths] of chains) {
    const points = finger(base, lengths, spec[name]);
    for (let i = 0; i < 4; i += 1) lm[baseIndex + i] = points[i];
  }

  // Thumb splays out to the side rather than standing up with the fingers.
  const thumbBase: Vec3 = { x: -0.03, y: -0.02, z: 0.006 };
  const thumbPoints = finger(thumbBase, [0.033, 0.032, 0.026], spec.thumb);
  const lean = (p: Vec3, k: number): Vec3 => ({ x: p.x - k, y: p.y + k * 0.5, z: p.z });
  for (let i = 0; i < 4; i += 1) {
    lm[LM.THUMB_CMC + i] = lean(thumbPoints[i], 0.012 * i);
  }

  return lm;
}

// --- gesture ----------------------------------------------------------------

console.log('\nGesture geometry');

const open = buildHand({
  thumb: [4, 4],
  index: [3, 3],
  middle: [3, 3],
  ring: [3, 3],
  pinky: [3, 3],
});
const openMetrics = measureHand(open);

ok(
  'hand scale is a plausible adult hand',
  openMetrics.handScale > 0.06 && openMetrics.handScale < 0.12,
  `${(openMetrics.handScale * 1000).toFixed(0)} mm`,
);
ok(
  'an open hand reads as extended fingers',
  openMetrics.curls.index < 15 && openMetrics.curls.pinky < 15,
  `index curl ${openMetrics.curls.index.toFixed(1)}deg`,
);

// curlOf must recover the bend angles that built the finger.
const bent = buildHand({
  thumb: [4, 4],
  index: [70, 55],
  middle: [3, 3],
  ring: [3, 3],
  pinky: [3, 3],
});
const bentMetrics = measureHand(bent);
ok(
  'curl recovers the exact joint angles it was built from',
  near(bentMetrics.curls.index, 125, 0.5),
  `expected 125deg, got ${bentMetrics.curls.index.toFixed(2)}deg`,
);

// The pose that defeats an image-space classifier: the finger curls straight at
// the camera, so its XY projection is nearly a single point.
const towardCamera = buildHand({
  thumb: [4, 4],
  index: [88, 62],
  middle: [3, 3],
  ring: [3, 3],
  pinky: [3, 3],
});
const tcMetrics = measureHand(towardCamera);
const projected2d = Math.hypot(
  towardCamera[LM.INDEX_MCP].x - towardCamera[LM.INDEX_TIP].x,
  towardCamera[LM.INDEX_MCP].y - towardCamera[LM.INDEX_TIP].y,
);
ok(
  'a finger curled at the camera nearly vanishes in 2D',
  projected2d < 0.03,
  `2D span only ${(projected2d * 1000).toFixed(1)} mm`,
);
ok(
  'but 3D still reads it as folded',
  tcMetrics.curls.index > 140,
  `curl ${tcMetrics.curls.index.toFixed(1)}deg`,
);
ok(
  'so point mode does not fire on it',
  scoreGesture(tcMetrics, 'point').score < 0.05,
  `score ${scoreGesture(tcMetrics, 'point').score.toFixed(3)}`,
);

// Pinch: place the thumb tip on the index tip.
const pinchHand = buildHand({
  thumb: [10, 10],
  index: [35, 25],
  middle: [3, 3],
  ring: [3, 3],
  pinky: [3, 3],
});
const tip = pinchHand[LM.INDEX_TIP];
pinchHand[LM.THUMB_TIP] = { x: tip.x + 0.008, y: tip.y + 0.006, z: tip.z + 0.004 };
const pinchMetrics = measureHand(pinchHand);

ok(
  'a pinch scores high in pinch mode',
  scoreGesture(pinchMetrics, 'pinch').score > 0.9,
  `score ${scoreGesture(pinchMetrics, 'pinch').score.toFixed(3)}, normalised gap ${pinchMetrics.pinch.toFixed(3)}`,
);
ok(
  'an open hand scores zero in pinch mode',
  scoreGesture(openMetrics, 'pinch').score < 0.02,
  `score ${scoreGesture(openMetrics, 'pinch').score.toFixed(3)}, gap ${openMetrics.pinch.toFixed(2)}`,
);

const pointing = buildHand({
  thumb: [20, 20],
  index: [4, 4],
  middle: [80, 60],
  ring: [80, 60],
  pinky: [80, 60],
});
const pointMetrics = measureHand(pointing);
ok(
  'pointing scores high in point mode',
  scoreGesture(pointMetrics, 'point').score > 0.9,
  `score ${scoreGesture(pointMetrics, 'point').score.toFixed(3)}`,
);
ok(
  'pointing does not fire pinch mode',
  scoreGesture(pointMetrics, 'pinch').score < 0.05,
  `score ${scoreGesture(pointMetrics, 'pinch').score.toFixed(3)}`,
);
ok(
  'an open hand fires none of the modes',
  scoreGesture(openMetrics, 'any').score < 0.1,
  `best ${scoreGesture(openMetrics, 'any').name} at ${scoreGesture(openMetrics, 'any').score.toFixed(3)}`,
);

// Grip needs ring and pinky tucked away, so a bare pinch must not satisfy it.
const gripHand = buildHand({
  thumb: [10, 10],
  index: [35, 25],
  middle: [40, 30],
  ring: [80, 60],
  pinky: [80, 60],
});
gripHand[LM.THUMB_TIP] = {
  x: gripHand[LM.INDEX_TIP].x + 0.008,
  y: gripHand[LM.INDEX_TIP].y + 0.006,
  z: gripHand[LM.INDEX_TIP].z + 0.004,
};
ok(
  'a full pen grip scores high in grip mode',
  scoreGesture(measureHand(gripHand), 'grip').score > 0.9,
  `score ${scoreGesture(measureHand(gripHand), 'grip').score.toFixed(3)}`,
);
ok(
  'a pinch with open fingers does not satisfy grip mode',
  scoreGesture(pinchMetrics, 'grip').score < 0.1,
  `score ${scoreGesture(pinchMetrics, 'grip').score.toFixed(3)}`,
);

// --- trigger ----------------------------------------------------------------

console.log('\nPen trigger');

{
  const trigger = new PenTrigger();
  ok('starts up', !trigger.update(0.0));
  ok('one strong frame is not enough to engage', !trigger.update(0.99));
  ok('two consecutive strong frames engage', trigger.update(0.99));
  ok('reports the press edge exactly once', trigger.justPressed);
  ok('stays down through a marginal frame', trigger.update(0.5));
  ok('does not re-report the press', !trigger.justPressed);
  ok('one weak frame does not release', trigger.update(0.1));
  ok('two weak frames release', !trigger.update(0.1));
  ok('reports the release edge', trigger.justReleased);
}

{
  // The Schmitt gap is the whole point: a score parked between the thresholds
  // must not toggle the pen on and off.
  const trigger = new PenTrigger();
  trigger.update(0.99);
  trigger.update(0.99);
  let flips = 0;
  let previous = trigger.isDown;
  for (let i = 0; i < 200; i += 1) {
    trigger.update(0.52 + Math.sin(i) * 0.06);
    if (trigger.isDown !== previous) flips += 1;
    previous = trigger.isDown;
  }
  ok('a score hovering between thresholds never chatters', flips === 0, `${flips} flips over 200 frames`);
}

// --- 1€ filter --------------------------------------------------------------

console.log('\nSmoothing');

{
  const config = { minCutoff: 1.4, beta: 0.012, derivativeCutoff: 1 };
  const filter = new OneEuroFilter(config);

  // Deterministic pseudo-noise so the result is reproducible.
  let seed = 12345;
  const noise = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff - 0.5) * 12;
  };

  let rawSpread = 0;
  let filteredSpread = 0;
  for (let i = 0; i < 200; i += 1) {
    const raw = 500 + noise();
    const out = filter.filter(raw, i / 60);
    if (i > 60) {
      rawSpread += Math.abs(raw - 500);
      filteredSpread += Math.abs(out - 500);
    }
  }
  ok(
    'a still fingertip is held steady against tracker jitter',
    filteredSpread < rawSpread * 0.35,
    `jitter cut to ${((filteredSpread / rawSpread) * 100).toFixed(0)}% of raw`,
  );

  // Same filter, now on a fast sweep: lag must stay small enough to feel attached.
  const fast = new OneEuroFilter(config);
  let out = 0;
  const speed = 900; // board units per second, a brisk stroke
  for (let i = 0; i < 120; i += 1) out = fast.filter((i / 60) * speed, i / 60);
  const truth = (119 / 60) * speed;
  const lagUnits = truth - out;
  const lagMs = (lagUnits / speed) * 1000;
  ok(
    'a fast stroke stays under the 50 ms latency budget',
    lagMs < 50,
    `${lagMs.toFixed(1)} ms of filter lag at ${speed} units/s`,
  );
}

// --- coordinate mapping -----------------------------------------------------

console.log('\nCoordinate mapping');

{
  const mapper = new FrameMapper();
  // A 16:9 camera in a taller-than-wide stage: cover crops top and bottom.
  mapper.configure(1280, 720, 1600, 1000, true);

  const centre = mapper.normalizedToStage(0.5, 0.5);
  ok(
    'the frame centre lands at the stage centre',
    near(centre.x, 800, 0.01) && near(centre.y, 500, 0.01),
    `(${centre.x.toFixed(1)}, ${centre.y.toFixed(1)})`,
  );

  const left = mapper.normalizedToStage(0.2, 0.5);
  ok('mirroring flips left to right', left.x > centre.x, `x ${left.x.toFixed(1)} vs centre 800`);

  mapper.configure(1280, 720, 1600, 1000, false);
  const unmirrored = mapper.normalizedToStage(0.2, 0.5);
  ok(
    'unmirrored keeps left on the left',
    unmirrored.x < centre.x && near(unmirrored.x + left.x, 1600, 0.01),
    `x ${unmirrored.x.toFixed(1)}`,
  );

  ok(
    'board space is isotropic',
    near(mapper.boardWidth, (1280 / 720) * 1000, 0.01),
    `board width ${mapper.boardWidth.toFixed(1)}`,
  );

  // Resizing must move ink with the frame, not distort it.
  const small = new FrameMapper();
  small.configure(1280, 720, 800, 500, false);
  const large = new FrameMapper();
  large.configure(1280, 720, 1600, 1000, false);
  const a1 = small.normalizedToStage(0.3, 0.7);
  const a2 = small.normalizedToStage(0.6, 0.2);
  const b1 = large.normalizedToStage(0.3, 0.7);
  const b2 = large.normalizedToStage(0.6, 0.2);
  const ratioX = (b2.x - b1.x) / (a2.x - a1.x);
  const ratioY = (b2.y - b1.y) / (a2.y - a1.y);
  ok(
    'doubling the stage scales ink uniformly',
    near(ratioX, 2, 0.001) && near(ratioY, 2, 0.001),
    `x ${ratioX.toFixed(4)}, y ${ratioY.toFixed(4)}`,
  );
}

// --- board ------------------------------------------------------------------

console.log('\nBoard history');

{
  const mapper = new FrameMapper();
  mapper.configure(1280, 720, 1280, 720, false);

  const board = new Board();
  board.resize(1280, 720, 1);

  board.beginStroke(1, 'pen', '#ff0000', 8, { x: 100, y: 100 });
  board.extendStroke(1, { x: 140, y: 100 });
  board.extendStroke(1, { x: 180, y: 100 });
  board.endStroke(1);
  ok('a finished stroke lands in history', board.stats.strokes === 1);

  board.beginStroke(1, 'pen', '#00ff00', 8, { x: 200, y: 200 });
  board.extendStroke(1, { x: 240, y: 200 });
  board.endStroke(1);
  ok('two strokes recorded', board.stats.strokes === 2);

  board.undo();
  ok('undo removes the last stroke', board.stats.strokes === 1);
  ok('undo enables redo', board.stats.canRedo);
  board.redo();
  ok('redo restores it', board.stats.strokes === 2);

  board.clear();
  ok('clear leaves nothing drawable', board.stats.strokes === 0);
  ok('but clear is itself undoable', board.stats.canUndo);
  board.undo();
  ok('undoing a clear brings the drawing back', board.stats.strokes === 2, `${board.stats.strokes} strokes`);

  // A new action must invalidate the redo branch.
  board.undo();
  board.beginStroke(2, 'pen', '#0000ff', 8, { x: 10, y: 10 });
  board.endStroke(2);
  ok('drawing after an undo drops the redo branch', !board.stats.canRedo);
}

{
  const board = new Board();
  board.resize(1280, 720, 1);

  board.beginStroke(1, 'pen', '#fff', 8, { x: 100, y: 100 });
  // Samples closer than the decimation threshold should be dropped.
  for (let i = 0; i < 50; i += 1) board.extendStroke(1, { x: 100 + i * 0.2, y: 100 });
  const decimated = [...board.activeStrokes][0].points.length;
  ok('sub-pixel jitter samples are decimated away', decimated < 8, `${decimated} points kept from 51`);

  // A teleport means the tracker re-acquired; the stroke must not bridge it.
  const accepted = board.extendStroke(1, { x: 900, y: 700 });
  ok('a tracking jump is rejected rather than drawn across', !accepted);
}

{
  // Two hands must not share stroke state.
  const board = new Board();
  board.resize(1280, 720, 1);
  board.beginStroke(1, 'pen', '#f00', 8, { x: 100, y: 100 });
  board.beginStroke(2, 'pen', '#0f0', 8, { x: 600, y: 100 });
  board.extendStroke(1, { x: 200, y: 100 });
  board.extendStroke(2, { x: 700, y: 100 });
  const strokes = [...board.activeStrokes];
  ok('both hands draw at once', strokes.length === 2);
  ok(
    'each hand keeps its own colour and points',
    strokes[0].color === '#f00' && strokes[1].color === '#0f0' &&
      strokes[0].points[1].x === 200 && strokes[1].points[1].x === 700,
  );
  board.endStroke(1);
  ok('closing one hand leaves the other drawing', [...board.activeStrokes].length === 1);
}

// --- pointer identity -------------------------------------------------------

console.log('\nPointer tracking');

{
  const mapper = new FrameMapper();
  mapper.configure(1280, 720, 1280, 720, false);

  // Normalised image landmarks; only the wrist and index tip matter here.
  const imageHand = (wristX: number, tipX: number, tipY: number) =>
    Array.from({ length: 21 }, (_, i) => ({
      x: i === LM.INDEX_TIP ? tipX : wristX,
      y: i === LM.INDEX_TIP ? tipY : 0.8,
      z: 0,
      visibility: 1,
    }));

  const result = (hands: Array<{ wristX: number; tipX: number; tipY: number; world: Vec3[] }>) =>
    ({
      landmarks: hands.map((h) => imageHand(h.wristX, h.tipX, h.tipY)),
      worldLandmarks: hands.map((h) => h.world),
      handedness: hands.map(() => [{ categoryName: 'Right', score: 0.99, index: 0, displayName: '' }]),
      handednesses: [],
    }) as never;

  const opts = (frame: number) => ({
    mapper,
    gestureMode: 'pinch' as const,
    smoothing: 0.5,
    time: frame / 60,
    frame,
  });

  const pinchWorld = pinchHand;
  const openWorld = open;

  {
    const tracker = new PointerTracker();
    let frame = 0;
    let last = tracker.update(result([{ wristX: 0.4, tipX: 0.5, tipY: 0.5, world: pinchWorld }]), opts(++frame));
    ok('a detected hand yields one pointer', last.length === 1);
    ok('the pen is not down on the very first frame', !last[0].isDown);

    last = tracker.update(result([{ wristX: 0.4, tipX: 0.5, tipY: 0.5, world: pinchWorld }]), opts(++frame));
    ok('a held pinch brings the pen down', last[0].isDown);

    // 0.5 normalised x on a 16:9 frame is half of 1777.8 board units.
    ok(
      'the nib tracks the index fingertip in board units',
      near(last[0].tip.x, 888.9, 60) && near(last[0].tip.y, 500, 60),
      `(${last[0].tip.x.toFixed(0)}, ${last[0].tip.y.toFixed(0)})`,
    );

    last = tracker.update(result([{ wristX: 0.4, tipX: 0.5, tipY: 0.5, world: openWorld }]), opts(++frame));
    last = tracker.update(result([{ wristX: 0.4, tipX: 0.5, tipY: 0.5, world: openWorld }]), opts(++frame));
    ok('opening the hand lifts the pen', !last[0].isDown);
  }

  {
    const tracker = new PointerTracker();
    let frame = 0;
    const twoHands = (swap: boolean) => {
      const a = { wristX: 0.25, tipX: 0.25, tipY: 0.5, world: pinchWorld };
      const b = { wristX: 0.75, tipX: 0.75, tipY: 0.5, world: openWorld };
      return result(swap ? [b, a] : [a, b]);
    };

    let out = tracker.update(twoHands(false), opts(++frame));
    ok('two hands yield two pointers', out.length === 2);
    const leftId = out.find((p) => p.tip.x < 800)!.id;
    const rightId = out.find((p) => p.tip.x > 800)!.id;
    ok('the two hands get distinct identities', leftId !== rightId);

    // MediaPipe gives no ordering guarantee — identity must survive a reorder.
    out = tracker.update(twoHands(true), opts(++frame));
    ok(
      'identity follows position, not array order',
      out.find((p) => p.tip.x < 800)!.id === leftId && out.find((p) => p.tip.x > 800)!.id === rightId,
    );

    // A hand leaving must eventually retire so its stroke gets closed. `retired`
    // is per-frame, so it has to be collected as it happens.
    const retirements: number[] = [];
    let framesUntilRetired = 0;
    for (let i = 0; i < 8; i += 1) {
      out = tracker.update(
        result([{ wristX: 0.75, tipX: 0.75, tipY: 0.5, world: openWorld }]),
        opts(++frame),
      );
      if (retirements.length === 0) framesUntilRetired += 1;
      retirements.push(...tracker.retired);
    }
    ok(
      'a hand that leaves the frame is retired',
      retirements.includes(leftId),
      `after ${framesUntilRetired} absent frames (~${Math.round((framesUntilRetired / 60) * 1000)} ms)`,
    );
    ok('the remaining hand keeps its identity', out.length === 1 && out[0].id === rightId);
  }

  {
    // A one-frame detection blip must not split a stroke in two.
    const tracker = new PointerTracker();
    let frame = 0;
    const present = result([{ wristX: 0.4, tipX: 0.5, tipY: 0.5, world: pinchWorld }]);
    tracker.update(present, opts(++frame));
    const id = tracker.update(present, opts(++frame))[0].id;
    tracker.update(result([]), opts(++frame));
    ok('a single dropped frame does not retire the hand', tracker.retired.length === 0);
    const back = tracker.update(present, opts(++frame));
    ok('the hand resumes with the same identity', back[0].id === id);
    ok('and the pen never lifted', back[0].isDown);
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
