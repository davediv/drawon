# Drawon

Drawon turns a webcam and an index finger into a real-time air canvas. Hand
landmarks are processed locally in the browser with MediaPipe; webcam frames are
not uploaded.

## Features

- Live, mirrored webcam feed with two-hand landmark tracking
- Pen-pose detection: extend the index finger and curl the other fingers
- Adaptive pointer smoothing and interpolated strokes
- Color, brush size, eraser, clear, undo, and redo controls
- Optional local background image
- Transparent PNG export
- Responsive and full-screen layouts

## Run locally

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Open the local URL, choose **Start camera**, and allow webcam access.

## Checks

```bash
npm run lint
npx tsc --noEmit
npm test
```

Camera access requires a secure context in production. MediaPipe downloads its
version-pinned WebAssembly runtime and hand landmark model on first load, then
performs inference on-device.
