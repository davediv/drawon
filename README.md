# Drawone

Draw in the air. Your webcam tracks your hand, a pen-holding gesture puts the
pen down, and your index fingertip inks onto a transparent canvas laid over the
video.

Everything runs in the browser. No frames are uploaded anywhere.

## Run it

```bash
npm install
npm run dev
```

Open the printed URL and press **Start camera**. The camera needs a secure
context, so use `localhost` or https — a plain `http://192.168.x.x` will be
blocked by the browser.

The first start loads an 8 MB hand model. It is served from `public/` and cached
after that, so the app works offline from then on.

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Typecheck, then build to `dist/` |
| `npm run preview` | Serve the production build |
| `npm test` | Run the logic checks (57 assertions) |

## Using it

Make the pen gesture and move your hand. Open the gesture and the line stops
immediately; what you drew stays until you erase or clear it.

Three gestures are available under the settings icon:

- **Pinch** (default) — touch your thumb to your index fingertip. Crisp on/off.
- **Point** — extend your index finger, fold the other three.
- **Pen grip** — pinch with your ring and little fingers tucked in. Strictest,
  so it is the least likely to start a stroke you did not mean.

Both hands are tracked, and both can draw at once.

The circle on the cursor is the real stroke width, so you can size a line before
committing to it. The arc that fills around it is how close your gesture is to
engaging — useful when a gesture feels like it should be firing and is not.

### Keys

| | |
| --- | --- |
| <kbd>P</kbd> / <kbd>E</kbd> | Pen / eraser |
| <kbd>[</kbd> / <kbd>]</kbd> | Brush size |
| <kbd>1</kbd>–<kbd>8</kbd> | Palette colour |
| <kbd>⌘Z</kbd> / <kbd>⇧⌘Z</kbd> | Undo / redo |
| <kbd>C</kbd> | Clear (undoable) |
| <kbd>S</kbd> | Save PNG |
| <kbd>H</kbd> | Hide the controls |

Save writes a transparent PNG of the drawing alone; the caret next to it also
offers a flattened PNG with the camera frame behind the ink. Both export at the
camera's native resolution rather than screenshotting the window.

## How it works

```
camera frame ─▶ HandLandmarker ─▶ gesture score ─▶ pen trigger
                     │                                  │
                     └─▶ index fingertip ─▶ 1€ filter ─▶ stroke ─▶ ink layer
```

A few decisions worth knowing about if you are changing this:

**Gestures are classified in 3D, not on the image.** MediaPipe returns metric
world landmarks alongside the projected ones, and finger curl is measured from
those. A finger curling toward the camera nearly vanishes in the 2D projection —
an image-space classifier reads it as still extended and the pen sticks down.
`tests/logic.test.ts` covers exactly that pose.

**The pen state is latched, not sampled.** A raw confidence score crossing a
threshold chatters. A Schmitt trigger (engage at 0.62, release at 0.42) plus a
two-frame debounce gives a clean edge while keeping release inside ~33 ms.

**Smoothing is a 1€ filter, not a moving average.** It filters hard when your
hand is nearly still and opens up as it accelerates, so jitter dies without the
line lagging behind fast strokes. Measured: jitter cut to 25% of raw, with 13 ms
of lag at stroke speed. The Smoothing slider trades those against each other.

**Strokes are vectors in camera space, not pixels.** Points are stored in an
isotropic "board" space where 1000 units spans the camera frame height. Resizing
the window re-projects the drawing instead of stretching or dropping it, undo
replays the action list, and export can render at native resolution.

**Clear is an action, so undo brings the drawing back.** The history is a list of
strokes and clears; replaying it reproduces any state.

**Two canvases, plus an offscreen cache.** Finished strokes are rasterised once
into the cache. Only in-progress strokes are re-traced each frame, and the
overlay (skeleton, cursor) is the only layer cleared every frame.

Erasing composites with `destination-out`, so it cuts real holes in the ink
rather than painting the background over it — which is what keeps the whiteboard
transparent above the video.

### Tuning

Thresholds live in `src/config.ts`: gesture engage/release points, curl angles
that count as extended or folded, smoothing endpoints, stroke decimation and the
jump distance that breaks a stroke when tracking re-acquires.

## Performance

Inference runs on the GPU delegate, falling back to CPU if WebGL is unavailable.
The loop is driven by `requestVideoFrameCallback` where supported, so there is
one inference per camera frame and no duplicated work; browsers without it fall
back to `requestAnimationFrame` with frame de-duplication.

The readout in the top left is live: `TRACK` is inference time, `PIPE` is from
frame capture to rendered ink.

## Layout

```
src/
  app.ts               loop, wiring, layout
  config.ts            tunable thresholds
  board/               stroke model, history, raster cache, PNG export
  lib/                 maths, 1€ filter
  render/              skeleton and cursor overlay
  tracking/            camera, MediaPipe wrapper, gesture maths, pointer identity
  ui/                  dock, settings, readout, persisted preferences
tests/logic.test.ts    gesture, trigger, filter, mapping, history, identity
public/                hand model and MediaPipe wasm, vendored for offline use
```

## Browser support

Chrome, Edge and Safari have everything. Firefox works but lacks
`requestVideoFrameCallback`, so it uses the animation-frame fallback.
