# Drawone

Draw in the air. Your webcam tracks your hand, a pen-holding gesture puts the
pen down, and your index fingertip inks onto a transparent canvas laid over the
video.

Everything runs on your machine. No frames are uploaded anywhere.

## Run it

```bash
pip install -r requirements.txt
python3 -m drawone
```

The first run needs camera permission. On macOS that is granted to whatever is
launching the app — System Settings › Privacy & Security › Camera — and the
prompt only appears once.

The hand model is `public/models/hand_landmarker.task`, already in the repo, so
nothing is downloaded and the app works offline. Point elsewhere with `--model`.

| Command | What it does |
| --- | --- |
| `python3 -m drawone` | Run it |
| `python3 -m drawone --list-cameras` | Print the camera indices it can see |
| `python3 -m drawone --camera 1 --no-mirror` | Pick a device, turn off the selfie flip |
| `python3 tests/test_logic.py` | Run the logic checks (57 assertions) |

Other flags: `--width/--height/--fps` for the requested capture mode, `--out DIR`
for where PNGs land, `--cpu` to skip the GPU delegate.

## Using it

Make the pen gesture and move your hand. Open the gesture and the line stops
immediately; what you drew stays until you erase or clear it.

Three gestures are available, cycled with <kbd>G</kbd>:

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
| <kbd>Z</kbd> / <kbd>Y</kbd> | Undo / redo |
| <kbd>C</kbd> | Clear (undoable) |
| <kbd>S</kbd> | Save transparent PNG |
| <kbd>⇧S</kbd> | Save PNG with the camera frame behind the ink |
| <kbd>G</kbd> | Gesture mode |
| <kbd>,</kbd> / <kbd>.</kbd> | Smoothing |
| <kbd>M</kbd> / <kbd>K</kbd> / <kbd>V</kbd> | Mirror / skeleton / camera view |
| <kbd>N</kbd> | Next camera |
| <kbd>H</kbd> | Hide the controls |
| <kbd>?</kbd> | Key list |
| <kbd>Q</kbd> / <kbd>Esc</kbd> | Quit |

Both exports render at the camera's native resolution rather than screenshotting
the window. Preferences persist to `~/.drawone/settings.json`.

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
`tests/test_logic.py` covers exactly that pose.

**The pen state is latched, not sampled.** A raw confidence score crossing a
threshold chatters. A Schmitt trigger (engage at 0.62, release at 0.42) plus a
two-frame debounce gives a clean edge while keeping release inside ~66 ms at
30 fps.

**Smoothing is a 1€ filter, not a moving average.** It filters hard when your
hand is nearly still and opens up as it accelerates, so jitter dies without the
line lagging behind fast strokes. Measured: jitter cut to 24% of raw, with 13 ms
of lag at stroke speed. The smoothing setting trades those against each other.

**Strokes are vectors in camera space, not pixels.** Points are stored in an
isotropic "board" space where 1000 units spans the camera frame height. Changing
resolution re-projects the drawing instead of stretching or dropping it, undo
replays the action list, and export can render at native resolution.

**Clear is an action, so undo brings the drawing back.** The history is a list of
strokes and clears; replaying it reproduces any state.

**Layers are premultiplied BGRA, with a dirty box.** OpenCV's antialiasing blends
every channel toward the target value, which *is* source-over compositing when
the source is premultiplied — so edges keep their colour against transparency
instead of darkening. Compositing onto the frame is then one multiply and one
add over the box the ink actually occupies, and the split planes are cached, so a
settled drawing costs 0.4 ms a frame no matter how much is on it.

**A stroke is rasterised through a coverage mask.** Stamping it segment by
segment would blend every overlap twice and leave a darker seam where a line
doubles back. Erasing needs that coverage as a mask anyway: it multiplies the
layer's alpha down rather than painting over it, which is what keeps the
whiteboard genuinely transparent and stops an erase from cutting a hole through
the camera frame in a composite export.

**Frames are pulled on their own thread.** OpenCV's queue would otherwise hand
back frames already stale by the time inference finished. The reader keeps only
the newest one; the loop skips inference on a frame it has already seen and caps
redraws of an unchanged frame at 60 Hz. Without that cap the loop spun at 330 Hz
re-compositing identical pixels, which starved inference badly enough to double
its time.

### Tuning

Thresholds live in `drawone/config.py`: gesture engage/release points, curl
angles that count as extended or folded, smoothing endpoints, stroke decimation
and the jump distance that breaks a stroke when tracking re-acquires.

## Performance

Inference runs on the GPU delegate, falling back to CPU if there is no usable
one. Measured on an M1 at 1280×720: **7.4 ms** per frame on the Metal delegate,
13.5 ms on CPU, and **10 ms** from frame capture to rendered ink.

The frame handed to MediaPipe is RGBA rather than RGB. This is not a detail you
can change back: the GPU delegate cannot upload a three-channel image and aborts
the process on a failed assertion rather than raising, so there is nothing to
catch and fall back from. The fourth channel costs 0.2 ms and is slightly faster
on CPU too.

The readout in the top left is live: `TRACK` is inference time, `PIPE` is from
frame capture to rendered ink.

## Layout

```
drawone/
  app.py               loop, wiring, layout
  __main__.py          command line
  config.py            tunable thresholds
  board/               stroke model, history, raster cache, PNG export
  lib/                 maths, 1€ filter
  render/              premultiplied layers, colour, skeleton and cursor overlay
  tracking/            camera, MediaPipe wrapper, gesture maths, pointer identity
  ui/                  dock, readout, key handling, persisted preferences
tests/test_logic.py    gesture, trigger, filter, mapping, history, identity
public/models/         hand model, vendored for offline use
```

## Requirements

Python 3.9 or newer, with MediaPipe, OpenCV and NumPy. Works on macOS, Linux and
Windows; the capture backend is picked per platform (AVFoundation, V4L2,
DirectShow).
