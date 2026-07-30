"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { HandLandmarker as HandLandmarkerInstance } from "@mediapipe/tasks-vision";
import {
  Camera,
  CameraOff,
  Check,
  Download,
  Eraser,
  ImagePlus,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Pencil,
  Redo2,
  RotateCcw,
  Sparkles,
  Trash2,
  Undo2,
  X,
} from "lucide-react";

const MEDIAPIPE_VERSION = "1.0.0";
const WASM_PATH = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const MODEL_PATH =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

const HAND_CONNECTIONS = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [5, 9],
  [9, 10],
  [10, 11],
  [11, 12],
  [9, 13],
  [13, 14],
  [14, 15],
  [15, 16],
  [13, 17],
  [17, 18],
  [18, 19],
  [19, 20],
  [0, 17],
] as const;

const COLOR_PRESETS = [
  "#ff5c35",
  "#ffd447",
  "#63e6be",
  "#58a6ff",
  "#c77dff",
  "#ffffff",
];

type TrackerStatus = "loading" | "ready" | "error";
type CameraStatus = "off" | "starting" | "on" | "error";
type Tool = "pen" | "eraser";
type Point = { x: number; y: number };
type LandmarkPoint = { x: number; y: number; z?: number };
type Stroke = {
  id: number;
  points: Point[];
  color: string;
  size: number;
  tool: Tool;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function distance3D(a: LandmarkPoint, b: LandmarkPoint) {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
}

function jointAngle(a: LandmarkPoint, b: LandmarkPoint, c: LandmarkPoint) {
  const ab = {
    x: a.x - b.x,
    y: a.y - b.y,
    z: (a.z ?? 0) - (b.z ?? 0),
  };
  const cb = {
    x: c.x - b.x,
    y: c.y - b.y,
    z: (c.z ?? 0) - (b.z ?? 0),
  };
  const denominator =
    Math.hypot(ab.x, ab.y, ab.z) * Math.hypot(cb.x, cb.y, cb.z);

  if (!denominator) return 0;
  const cosine = clamp(
    (ab.x * cb.x + ab.y * cb.y + ab.z * cb.z) / denominator,
    -1,
    1,
  );
  return (Math.acos(cosine) * 180) / Math.PI;
}

function fingerIsExtended(
  landmarks: LandmarkPoint[],
  mcp: number,
  pip: number,
  dip: number,
  tip: number,
) {
  return (
    jointAngle(landmarks[mcp], landmarks[pip], landmarks[dip]) > 150 &&
    jointAngle(landmarks[pip], landmarks[dip], landmarks[tip]) > 150 &&
    distance3D(landmarks[tip], landmarks[0]) >
      distance3D(landmarks[pip], landmarks[0]) * 1.12
  );
}

function fingerIsCurled(
  landmarks: LandmarkPoint[],
  mcp: number,
  pip: number,
  dip: number,
  tip: number,
) {
  return (
    jointAngle(landmarks[mcp], landmarks[pip], landmarks[dip]) < 145 ||
    jointAngle(landmarks[pip], landmarks[dip], landmarks[tip]) < 145 ||
    distance3D(landmarks[tip], landmarks[0]) <
      distance3D(landmarks[pip], landmarks[0]) * 1.05
  );
}

function isPenPose(landmarks: LandmarkPoint[]) {
  if (landmarks.length !== 21) return false;

  return (
    fingerIsExtended(landmarks, 5, 6, 7, 8) &&
    fingerIsCurled(landmarks, 9, 10, 11, 12) &&
    fingerIsCurled(landmarks, 13, 14, 15, 16) &&
    fingerIsCurled(landmarks, 17, 18, 19, 20)
  );
}

function mapLandmarkToStage(
  landmark: LandmarkPoint,
  video: HTMLVideoElement,
  width: number,
  height: number,
): Point {
  const videoWidth = video.videoWidth || width;
  const videoHeight = video.videoHeight || height;
  const scale = Math.max(width / videoWidth, height / videoHeight);
  const renderedWidth = videoWidth * scale;
  const renderedHeight = videoHeight * scale;
  const offsetX = (width - renderedWidth) / 2;
  const offsetY = (height - renderedHeight) / 2;

  return {
    x: (offsetX + (1 - landmark.x) * renderedWidth) / width,
    y: (offsetY + landmark.y * renderedHeight) / height,
  };
}

function prepareContext(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d");
  if (!context) return null;

  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const ratio = width ? canvas.width / width : 1;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { context, width, height };
}

function drawStrokePath(
  context: CanvasRenderingContext2D,
  stroke: Stroke,
  width: number,
  height: number,
  sizeScale = 1,
  startIndex = 0,
) {
  if (!stroke.points.length) return;

  context.save();
  context.globalCompositeOperation =
    stroke.tool === "eraser" ? "destination-out" : "source-over";
  context.strokeStyle = stroke.color;
  context.fillStyle = stroke.color;
  context.lineWidth = stroke.size * sizeScale;
  context.lineCap = "round";
  context.lineJoin = "round";

  const firstPointIndex = Math.max(0, startIndex - 1);
  const firstPoint = stroke.points[firstPointIndex];

  if (stroke.points.length === 1) {
    context.beginPath();
    context.arc(
      firstPoint.x * width,
      firstPoint.y * height,
      (stroke.size * sizeScale) / 2,
      0,
      Math.PI * 2,
    );
    context.fill();
    context.restore();
    return;
  }

  context.beginPath();
  context.moveTo(firstPoint.x * width, firstPoint.y * height);
  for (let index = firstPointIndex + 1; index < stroke.points.length; index++) {
    const point = stroke.points[index];
    context.lineTo(point.x * width, point.y * height);
  }
  context.stroke();
  context.restore();
}

function replayStrokes(canvas: HTMLCanvasElement, strokes: Stroke[]) {
  const prepared = prepareContext(canvas);
  if (!prepared) return;

  const { context, width, height } = prepared;
  context.clearRect(0, 0, width, height);
  strokes.forEach((stroke) =>
    drawStrokePath(context, stroke, width, height),
  );
}

function clearOverlay(canvas: HTMLCanvasElement) {
  const prepared = prepareContext(canvas);
  if (!prepared) return;
  prepared.context.clearRect(0, 0, prepared.width, prepared.height);
}

function cameraErrorMessage(error: unknown) {
  if (!(error instanceof DOMException)) {
    return "The camera could not be started. Check your browser settings and try again.";
  }

  if (error.name === "NotAllowedError" || error.name === "SecurityError") {
    return "Camera access was blocked. Allow camera access in your browser, then try again.";
  }
  if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
    return "No camera was found on this device.";
  }
  if (error.name === "NotReadableError" || error.name === "TrackStartError") {
    return "Your camera is already in use by another app.";
  }
  return "The camera could not be started. Check your browser settings and try again.";
}

function drawCoverImage(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  width: number,
  height: number,
) {
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const drawWidth = image.naturalWidth * scale;
  const drawHeight = image.naturalHeight * scale;
  context.drawImage(
    image,
    (width - drawWidth) / 2,
    (height - drawHeight) / 2,
    drawWidth,
    drawHeight,
  );
}

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const artworkCanvasRef = useRef<HTMLCanvasElement>(null);
  const trackingCanvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const backgroundImageRef = useRef<HTMLImageElement>(null);
  const backgroundUrlRef = useRef<string | null>(null);

  const landmarkerRef = useRef<HandLandmarkerInstance | null>(null);
  const trackerGenerationRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const lastVideoTimeRef = useRef(-1);
  const lastTimestampRef = useRef(0);
  const lastInferenceAtRef = useRef(0);
  const inferenceFailureCountRef = useRef(0);
  const frameCountRef = useRef(0);
  const fpsStartedAtRef = useRef(0);

  const strokesRef = useRef<Stroke[]>([]);
  const redoStackRef = useRef<Stroke[]>([]);
  const activeStrokeRef = useRef<Stroke | null>(null);
  const strokeIdRef = useRef(0);
  const smoothedPointRef = useRef<Point | null>(null);
  const activeHandPointRef = useRef<Point | null>(null);
  const lastPointerAtRef = useRef(0);
  const penFrameCountRef = useRef(0);
  const activeHandIndexRef = useRef<number | null>(null);
  const gestureActiveRef = useRef(false);
  const drawingRef = useRef(false);
  const handsCountRef = useRef(0);
  const cameraActiveRef = useRef(false);

  const toolRef = useRef<Tool>("pen");
  const colorRef = useRef("#ff5c35");
  const brushSizeRef = useRef(8);
  const showLandmarksRef = useRef(true);

  const [trackerStatus, setTrackerStatus] =
    useState<TrackerStatus>("loading");
  const [cameraStatus, setCameraStatus] = useState<CameraStatus>("off");
  const [cameraError, setCameraError] = useState("");
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState("#ff5c35");
  const [brushSize, setBrushSize] = useState(8);
  const [showLandmarks, setShowLandmarks] = useState(true);
  const [handsCount, setHandsCount] = useState(0);
  const [fps, setFps] = useState(0);
  const [gestureActive, setGestureActive] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const [historyState, setHistoryState] = useState({ undo: 0, redo: 0 });
  const [backgroundUrl, setBackgroundUrl] = useState<string | null>(null);
  const [backgroundReady, setBackgroundReady] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [videoAspect, setVideoAspect] = useState(16 / 9);

  useEffect(() => {
    toolRef.current = tool;
  }, [tool]);

  useEffect(() => {
    colorRef.current = color;
  }, [color]);

  useEffect(() => {
    brushSizeRef.current = brushSize;
  }, [brushSize]);

  useEffect(() => {
    showLandmarksRef.current = showLandmarks;
  }, [showLandmarks]);

  const redrawArtwork = useCallback(() => {
    if (artworkCanvasRef.current) {
      replayStrokes(artworkCanvasRef.current, strokesRef.current);
    }
  }, []);

  const syncHistoryState = useCallback(() => {
    setHistoryState({
      undo: strokesRef.current.length,
      redo: redoStackRef.current.length,
    });
  }, []);

  const resizeCanvases = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const { width, height } = stage.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);

    [artworkCanvasRef.current, trackingCanvasRef.current].forEach((canvas) => {
      if (!canvas) return;
      const nextWidth = Math.max(1, Math.round(width * ratio));
      const nextHeight = Math.max(1, Math.round(height * ratio));
      if (canvas.width !== nextWidth || canvas.height !== nextHeight) {
        canvas.width = nextWidth;
        canvas.height = nextHeight;
      }
    });

    redrawArtwork();
    if (trackingCanvasRef.current) clearOverlay(trackingCanvasRef.current);
  }, [redrawArtwork]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const observer = new ResizeObserver(resizeCanvases);
    observer.observe(stage);
    resizeCanvases();

    return () => observer.disconnect();
  }, [resizeCanvases]);

  const finishStroke = useCallback(() => {
    activeStrokeRef.current = null;

    if (drawingRef.current) {
      drawingRef.current = false;
      setIsDrawing(false);
    }
  }, []);

  const setGesture = useCallback((active: boolean) => {
    if (gestureActiveRef.current === active) return;
    gestureActiveRef.current = active;
    setGestureActive(active);
  }, []);

  const resetTrackingState = useCallback(() => {
    penFrameCountRef.current = 0;
    smoothedPointRef.current = null;
    activeHandPointRef.current = null;
    activeHandIndexRef.current = null;
    lastPointerAtRef.current = 0;
    setGesture(false);
    finishStroke();

    if (handsCountRef.current !== 0) {
      handsCountRef.current = 0;
      setHandsCount(0);
    }
  }, [finishStroke, setGesture]);

  const stopCamera = useCallback(() => {
    cameraActiveRef.current = false;
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;

    resetTrackingState();
    if (trackingCanvasRef.current) clearOverlay(trackingCanvasRef.current);
    setFps(0);
    setCameraStatus("off");
  }, [resetTrackingState]);

  const loadTracker = useCallback(async () => {
    const generation = ++trackerGenerationRef.current;
    landmarkerRef.current?.close();
    landmarkerRef.current = null;

    try {
      const { FilesetResolver, HandLandmarker } = await import(
        "@mediapipe/tasks-vision"
      );
      const vision = await FilesetResolver.forVisionTasks(WASM_PATH);
      const options = {
        baseOptions: {
          modelAssetPath: MODEL_PATH,
          delegate: "GPU" as const,
        },
        runningMode: "VIDEO" as const,
        numHands: 2,
        minHandDetectionConfidence: 0.55,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      };

      let landmarker: HandLandmarkerInstance;
      try {
        landmarker = await HandLandmarker.createFromOptions(vision, options);
      } catch {
        landmarker = await HandLandmarker.createFromOptions(vision, {
          ...options,
          baseOptions: {
            modelAssetPath: MODEL_PATH,
            delegate: "CPU",
          },
        });
      }

      if (generation !== trackerGenerationRef.current) {
        landmarker.close();
        return;
      }

      landmarkerRef.current = landmarker;
      setTrackerStatus("ready");
    } catch {
      if (generation !== trackerGenerationRef.current) return;
      setTrackerStatus("error");
      setCameraError(
        "Hand tracking could not be loaded. Check your connection and try again.",
      );
    }
  }, []);

  const retryTracker = useCallback(() => {
    setTrackerStatus("loading");
    setCameraError("");
    void loadTracker();
  }, [loadTracker]);

  useEffect(() => {
    const trackerTimer = window.setTimeout(() => {
      void loadTracker();
    }, 0);

    return () => {
      window.clearTimeout(trackerTimer);
      trackerGenerationRef.current += 1;
      cameraActiveRef.current = false;
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      landmarkerRef.current?.close();
      if (backgroundUrlRef.current) {
        URL.revokeObjectURL(backgroundUrlRef.current);
      }
    };
  }, [loadTracker]);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === workspaceRef.current);
      window.setTimeout(resizeCanvases, 0);
    };

    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () =>
      document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, [resizeCanvases]);

  const addDrawingPoint = useCallback(
    (point: Point, timestamp: number) => {
      const canvas = artworkCanvasRef.current;
      if (!canvas) return;

      let stroke = activeStrokeRef.current;
      if (
        stroke &&
        (timestamp - lastPointerAtRef.current > 140 ||
          Math.hypot(
            (point.x - stroke.points[stroke.points.length - 1].x) *
              canvas.clientWidth,
            (point.y - stroke.points[stroke.points.length - 1].y) *
              canvas.clientHeight,
          ) >
            Math.min(canvas.clientWidth, canvas.clientHeight) * 0.24)
      ) {
        finishStroke();
        stroke = null;
      }

      if (!stroke) {
        stroke = {
          id: ++strokeIdRef.current,
          points: [point],
          color: colorRef.current,
          size: brushSizeRef.current,
          tool: toolRef.current,
        };
        activeStrokeRef.current = stroke;
        strokesRef.current.push(stroke);
        redoStackRef.current = [];
        drawingRef.current = true;
        setIsDrawing(true);
        syncHistoryState();

        const prepared = prepareContext(canvas);
        if (prepared) {
          drawStrokePath(
            prepared.context,
            stroke,
            prepared.width,
            prepared.height,
          );
        }
        lastPointerAtRef.current = timestamp;
        return;
      }

      const previous = stroke.points[stroke.points.length - 1];
      const distancePixels = Math.hypot(
        (point.x - previous.x) * canvas.clientWidth,
        (point.y - previous.y) * canvas.clientHeight,
      );
      if (distancePixels < 0.6) {
        lastPointerAtRef.current = timestamp;
        return;
      }

      const spacing = Math.max(2, stroke.size * 0.45);
      const steps = Math.min(28, Math.max(1, Math.ceil(distancePixels / spacing)));
      const startIndex = stroke.points.length;

      for (let index = 1; index <= steps; index++) {
        const progress = index / steps;
        stroke.points.push({
          x: previous.x + (point.x - previous.x) * progress,
          y: previous.y + (point.y - previous.y) * progress,
        });
      }

      const prepared = prepareContext(canvas);
      if (prepared) {
        drawStrokePath(
          prepared.context,
          stroke,
          prepared.width,
          prepared.height,
          1,
          startIndex,
        );
      }
      lastPointerAtRef.current = timestamp;
    },
    [finishStroke, syncHistoryState],
  );

  const drawTracking = useCallback(
    (
      hands: Point[][],
      activeHandIndex: number,
      pointer: Point | null,
      penIsActive: boolean,
    ) => {
      const canvas = trackingCanvasRef.current;
      if (!canvas) return;

      const prepared = prepareContext(canvas);
      if (!prepared) return;
      const { context, width, height } = prepared;
      context.clearRect(0, 0, width, height);

      if (showLandmarksRef.current) {
        hands.forEach((hand, handIndex) => {
          const isActiveHand = handIndex === activeHandIndex;
          context.save();
          context.strokeStyle = isActiveHand
            ? "rgba(255, 105, 70, 0.82)"
            : "rgba(255, 255, 255, 0.38)";
          context.lineWidth = isActiveHand ? 2.2 : 1.5;
          context.beginPath();
          HAND_CONNECTIONS.forEach(([from, to]) => {
            context.moveTo(hand[from].x * width, hand[from].y * height);
            context.lineTo(hand[to].x * width, hand[to].y * height);
          });
          context.stroke();

          hand.forEach((point, pointIndex) => {
            context.beginPath();
            context.fillStyle =
              pointIndex === 8 && isActiveHand
                ? "#fff7f1"
                : isActiveHand
                  ? "#ff6847"
                  : "rgba(255,255,255,.62)";
            context.arc(
              point.x * width,
              point.y * height,
              pointIndex === 8 ? 4.2 : 2.3,
              0,
              Math.PI * 2,
            );
            context.fill();
          });
          context.restore();
        });
      }

      if (pointer) {
        const x = pointer.x * width;
        const y = pointer.y * height;
        const radius =
          toolRef.current === "eraser"
            ? brushSizeRef.current / 2 + 5
            : Math.max(9, brushSizeRef.current / 2 + 5);

        context.save();
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fillStyle = penIsActive
          ? toolRef.current === "eraser"
            ? "rgba(255,255,255,.16)"
            : colorRef.current
          : "rgba(8, 10, 11, .28)";
        context.fill();
        context.strokeStyle = penIsActive ? "#ffffff" : "rgba(255,255,255,.9)";
        context.lineWidth = penIsActive ? 2.5 : 1.5;
        if (toolRef.current === "eraser") context.setLineDash([4, 4]);
        context.stroke();
        context.beginPath();
        context.arc(x, y, 2.2, 0, Math.PI * 2);
        context.fillStyle = "#ffffff";
        context.fill();
        context.restore();
      }
    },
    [],
  );

  const processTrackingResult = useCallback(
    (
      landmarks: LandmarkPoint[][],
      worldLandmarks: LandmarkPoint[][],
      timestamp: number,
    ) => {
      const video = videoRef.current;
      const canvas = trackingCanvasRef.current;
      if (!video || !canvas) return;

      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const handCount = landmarks.length;
      if (handsCountRef.current !== handCount) {
        handsCountRef.current = handCount;
        setHandsCount(handCount);
      }

      if (!handCount) {
        resetTrackingState();
        drawTracking([], -1, null, false);
        return;
      }

      const mappedHands = landmarks.map((hand) =>
        hand.map((point) =>
          mapLandmarkToStage(point, video, width, height),
        ),
      );
      const penPoseByHand = landmarks.map((hand, index) =>
        isPenPose(worldLandmarks[index] ?? hand),
      );
      const penCandidates = penPoseByHand
        .map((isPen, index) => {
          const tip = mappedHands[index][8];
          return isPen &&
            tip.x >= 0 &&
            tip.x <= 1 &&
            tip.y >= 0 &&
            tip.y <= 1
            ? index
            : -1;
        })
        .filter((index) => index >= 0);
      const candidatePool = penCandidates.length
        ? penCandidates
        : mappedHands.map((_, index) => index);

      let activeHandIndex = candidatePool[0] ?? 0;
      if (activeHandPointRef.current && candidatePool.length > 1) {
        activeHandIndex = candidatePool.reduce((closest, index) => {
          const point = mappedHands[index][8];
          const closestPoint = mappedHands[closest][8];
          const previous = activeHandPointRef.current as Point;
          const distance = Math.hypot(point.x - previous.x, point.y - previous.y);
          const closestDistance = Math.hypot(
            closestPoint.x - previous.x,
            closestPoint.y - previous.y,
          );
          return distance < closestDistance ? index : closest;
        }, activeHandIndex);
      }

      const rawPoint = mappedHands[activeHandIndex][8];
      if (
        activeHandIndexRef.current !== null &&
        activeHandIndexRef.current !== activeHandIndex
      ) {
        finishStroke();
        setGesture(false);
        penFrameCountRef.current = 0;
        smoothedPointRef.current = null;
      }
      activeHandIndexRef.current = activeHandIndex;
      activeHandPointRef.current = rawPoint;
      const previousPoint = smoothedPointRef.current;
      const elapsed = Math.max(8, timestamp - lastPointerAtRef.current);
      const movement = previousPoint
        ? Math.hypot(
            (rawPoint.x - previousPoint.x) * width,
            (rawPoint.y - previousPoint.y) * height,
          )
        : 0;
      const speed = movement / (elapsed / 1000);
      const smoothing = previousPoint
        ? clamp(0.24 + speed / 1800, 0.24, 0.76)
        : 1;
      const smoothedPoint = previousPoint
        ? {
            x: previousPoint.x + (rawPoint.x - previousPoint.x) * smoothing,
            y: previousPoint.y + (rawPoint.y - previousPoint.y) * smoothing,
          }
        : rawPoint;
      smoothedPointRef.current = smoothedPoint;

      const pointerIsVisible =
        rawPoint.x >= 0 &&
        rawPoint.x <= 1 &&
        rawPoint.y >= 0 &&
        rawPoint.y <= 1;
      const rawPenPose = penPoseByHand[activeHandIndex] && pointerIsVisible;
      if (rawPenPose) {
        penFrameCountRef.current += 1;
      } else {
        penFrameCountRef.current = 0;
      }

      const penIsActive = rawPenPose && penFrameCountRef.current >= 2;
      if (!rawPenPose) {
        setGesture(false);
        finishStroke();
      } else if (penIsActive) {
        setGesture(true);
        addDrawingPoint(smoothedPoint, timestamp);
      }

      drawTracking(
        mappedHands,
        activeHandIndex,
        smoothedPoint,
        penIsActive,
      );
    },
    [
      addDrawingPoint,
      drawTracking,
      finishStroke,
      resetTrackingState,
      setGesture,
    ],
  );

  const startCamera = useCallback(async () => {
    if (trackerStatus !== "ready" || cameraActiveRef.current) return;

    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraStatus("error");
      setCameraError(
        "This browser does not support webcam access. Try a current version of Chrome, Edge, or Safari.",
      );
      return;
    }

    setCameraStatus("starting");
    setCameraError("");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 60, max: 60 },
          facingMode: "user",
        },
      });
      const video = videoRef.current;
      if (!video) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      streamRef.current = stream;
      video.srcObject = stream;
      await video.play();
      setVideoAspect(
        video.videoWidth && video.videoHeight
          ? video.videoWidth / video.videoHeight
          : 16 / 9,
      );

      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.onended = () => {
          if (cameraActiveRef.current) stopCamera();
        };
      }

      cameraActiveRef.current = true;
      lastVideoTimeRef.current = -1;
      lastTimestampRef.current = 0;
      lastInferenceAtRef.current = 0;
      inferenceFailureCountRef.current = 0;
      frameCountRef.current = 0;
      fpsStartedAtRef.current = performance.now();
      setCameraStatus("on");
      window.setTimeout(resizeCanvases, 0);

      const loop = () => {
        if (!cameraActiveRef.current) return;

        const currentVideo = videoRef.current;
        const landmarker = landmarkerRef.current;
        const now = performance.now();
        if (
          currentVideo &&
          landmarker &&
          currentVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
          currentVideo.currentTime !== lastVideoTimeRef.current &&
          now - lastInferenceAtRef.current >= 1000 / 30
        ) {
          lastInferenceAtRef.current = now;
          lastVideoTimeRef.current = currentVideo.currentTime;
          const timestamp = Math.max(now, lastTimestampRef.current + 0.01);
          lastTimestampRef.current = timestamp;

          try {
            const result = landmarker.detectForVideo(currentVideo, timestamp);
            inferenceFailureCountRef.current = 0;
            processTrackingResult(
              result.landmarks,
              result.worldLandmarks,
              timestamp,
            );
            frameCountRef.current += 1;
          } catch {
            inferenceFailureCountRef.current += 1;
            resetTrackingState();
            if (trackingCanvasRef.current) {
              clearOverlay(trackingCanvasRef.current);
            }

            if (inferenceFailureCountRef.current >= 5) {
              stopCamera();
              landmarkerRef.current?.close();
              landmarkerRef.current = null;
              setTrackerStatus("error");
              setCameraStatus("error");
              setCameraError(
                "Hand tracking stopped responding. Retry to start a fresh session.",
              );
              return;
            }
          }

          const fpsElapsed = now - fpsStartedAtRef.current;
          if (fpsElapsed >= 600) {
            setFps(Math.round((frameCountRef.current * 1000) / fpsElapsed));
            frameCountRef.current = 0;
            fpsStartedAtRef.current = now;
          }
        }

        animationFrameRef.current = requestAnimationFrame(loop);
      };

      animationFrameRef.current = requestAnimationFrame(loop);
    } catch (error) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      setCameraStatus("error");
      setCameraError(cameraErrorMessage(error));
    }
  }, [
    processTrackingResult,
    resetTrackingState,
    resizeCanvases,
    stopCamera,
    trackerStatus,
  ]);

  const undo = useCallback(() => {
    finishStroke();
    const stroke = strokesRef.current.pop();
    if (!stroke) return;
    redoStackRef.current.push(stroke);
    redrawArtwork();
    syncHistoryState();
  }, [finishStroke, redrawArtwork, syncHistoryState]);

  const redo = useCallback(() => {
    finishStroke();
    const stroke = redoStackRef.current.pop();
    if (!stroke) return;
    strokesRef.current.push(stroke);
    redrawArtwork();
    syncHistoryState();
  }, [finishStroke, redrawArtwork, syncHistoryState]);

  const clearCanvas = useCallback(() => {
    finishStroke();
    if (!strokesRef.current.length) return;
    strokesRef.current = [];
    redoStackRef.current = [];
    redrawArtwork();
    syncHistoryState();
  }, [finishStroke, redrawArtwork, syncHistoryState]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable
      ) {
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [redo, undo]);

  const handleBackground = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      if (backgroundUrlRef.current) {
        URL.revokeObjectURL(backgroundUrlRef.current);
      }
      const nextUrl = URL.createObjectURL(file);
      backgroundUrlRef.current = nextUrl;
      setBackgroundReady(false);
      setBackgroundUrl(nextUrl);
      event.target.value = "";
    },
    [],
  );

  const removeBackground = useCallback(() => {
    if (backgroundUrlRef.current) {
      URL.revokeObjectURL(backgroundUrlRef.current);
    }
    backgroundUrlRef.current = null;
    setBackgroundReady(false);
    setBackgroundUrl(null);
  }, []);

  const saveDrawing = useCallback(() => {
    const artwork = artworkCanvasRef.current;
    if (!artwork) return;

    finishStroke();
    const stageWidth = Math.max(1, artwork.clientWidth);
    const stageHeight = Math.max(1, artwork.clientHeight);
    const naturalWidth = videoRef.current?.videoWidth || 1600;
    const exportWidth = Math.min(2400, Math.max(1200, naturalWidth));
    const exportHeight = Math.round(exportWidth * (stageHeight / stageWidth));
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = exportWidth;
    exportCanvas.height = exportHeight;
    const context = exportCanvas.getContext("2d");
    if (!context) return;
    const artworkLayer = document.createElement("canvas");
    artworkLayer.width = exportWidth;
    artworkLayer.height = exportHeight;
    const artworkContext = artworkLayer.getContext("2d");
    if (!artworkContext) return;

    const background = backgroundImageRef.current;
    if (background?.complete && background.naturalWidth) {
      drawCoverImage(context, background, exportWidth, exportHeight);
    }

    strokesRef.current.forEach((stroke) =>
      drawStrokePath(
        artworkContext,
        stroke,
        exportWidth,
        exportHeight,
        exportWidth / stageWidth,
      ),
    );
    context.drawImage(artworkLayer, 0, 0);

    exportCanvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const date = new Date();
      const stamp = date
        .toISOString()
        .replaceAll(":", "-")
        .replace(/\..+$/, "");
      anchor.href = url;
      anchor.download = `drawon-${stamp}.png`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, "image/png");
  }, [finishStroke]);

  const toggleFullscreen = useCallback(async () => {
    const workspace = workspaceRef.current;
    if (!workspace?.requestFullscreen) return;

    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await workspace.requestFullscreen();
      }
    } catch {
      // Full screen can be unavailable inside embedded or restricted browsers.
    }
  }, []);

  const hasStrokes = historyState.undo > 0;
  const canRedo = historyState.redo > 0;

  return (
    <main className="app-shell">
      <header className="app-header">
        <a className="brand" href="#" aria-label="Drawon home">
          <span className="brand-mark" aria-hidden="true">
            <span />
          </span>
          <span className="brand-name">drawon</span>
          <span className="brand-edition">AIR CANVAS</span>
        </a>

        <div className="privacy-chip">
          <span className="privacy-dot" />
          <span>On-device tracking</span>
        </div>
      </header>

      <section className="workspace" ref={workspaceRef}>
        <div className="toolbar" role="toolbar" aria-label="Drawing controls">
          <div className="tool-section color-section">
            <span className="tool-label">Ink</span>
            <label className="color-picker" title="Choose any color">
              <span style={{ backgroundColor: color }} />
              <input
                type="color"
                value={color}
                onChange={(event) => {
                  setColor(event.target.value);
                  setTool("pen");
                }}
                aria-label="Drawing color"
              />
            </label>
            <div className="color-presets" aria-label="Color presets">
              {COLOR_PRESETS.map((preset) => (
                <button
                  className={color === preset ? "color-dot active" : "color-dot"}
                  key={preset}
                  style={{ "--swatch": preset } as React.CSSProperties}
                  onClick={() => {
                    setColor(preset);
                    setTool("pen");
                  }}
                  aria-label={`Use color ${preset}`}
                  aria-pressed={color === preset}
                />
              ))}
            </div>
          </div>

          <div className="toolbar-divider" />

          <div className="tool-section brush-section">
            <label className="tool-label" htmlFor="brush-size">
              Brush
            </label>
            <Pencil size={17} aria-hidden="true" />
            <input
              id="brush-size"
              className="brush-slider"
              type="range"
              min="2"
              max="34"
              step="1"
              value={brushSize}
              onChange={(event) => setBrushSize(Number(event.target.value))}
              aria-label="Brush thickness"
            />
            <output className="brush-value">{brushSize}px</output>
          </div>

          <div className="toolbar-divider" />

          <button
            className={tool === "eraser" ? "tool-button active" : "tool-button"}
            onClick={() => setTool(tool === "eraser" ? "pen" : "eraser")}
            aria-pressed={tool === "eraser"}
            aria-label={
              tool === "eraser" ? "Switch to drawing pen" : "Use eraser"
            }
            title="Toggle eraser"
          >
            <Eraser size={18} />
            <span>Eraser</span>
          </button>

          <button
            className="icon-button"
            onClick={undo}
            disabled={!hasStrokes}
            title="Undo (Ctrl/⌘ Z)"
            aria-label="Undo"
          >
            <Undo2 size={18} />
          </button>
          <button
            className="icon-button"
            onClick={redo}
            disabled={!canRedo}
            title="Redo (Ctrl/⌘ Shift Z)"
            aria-label="Redo"
          >
            <Redo2 size={18} />
          </button>
          <button
            className="icon-button danger"
            onClick={clearCanvas}
            disabled={!hasStrokes}
            title="Clear canvas"
            aria-label="Clear canvas"
          >
            <Trash2 size={18} />
          </button>

          <div className="toolbar-spacer" />

          <input
            ref={fileInputRef}
            className="visually-hidden"
            type="file"
            accept="image/*"
            onChange={handleBackground}
            aria-label="Load a background image"
          />
          <div className="background-actions">
            <button
              className="tool-button secondary"
              onClick={() => fileInputRef.current?.click()}
              aria-label={
                backgroundUrl
                  ? "Replace background image"
                  : "Load a background image"
              }
            >
              <ImagePlus size={18} />
              <span>{backgroundUrl ? "Replace" : "Background"}</span>
            </button>
            {backgroundUrl && (
              <button
                className="remove-background"
                onClick={removeBackground}
                title="Remove background"
                aria-label="Remove background"
              >
                <X size={15} />
              </button>
            )}
          </div>

          <button
            className={
              showLandmarks ? "tool-button secondary active" : "tool-button secondary"
            }
            onClick={() => setShowLandmarks((visible) => !visible)}
            aria-pressed={showLandmarks}
            aria-label={
              showLandmarks
                ? "Hide hand landmark guide"
                : "Show hand landmark guide"
            }
          >
            <Sparkles size={18} />
            <span>Guide</span>
          </button>

          <button
            className="save-button"
            onClick={saveDrawing}
            aria-label="Save drawing as PNG"
            disabled={Boolean(backgroundUrl) && !backgroundReady}
          >
            <Download size={18} />
            <span>Save PNG</span>
          </button>
        </div>

        <section className="studio" aria-label="Air drawing studio">
          <div
            className={
              backgroundUrl ? "camera-stage with-background" : "camera-stage"
            }
            ref={stageRef}
            style={{ aspectRatio: videoAspect }}
          >
            {backgroundUrl && (
              // The upload stays local to the browser.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                ref={backgroundImageRef}
                className="background-image"
                src={backgroundUrl}
                alt=""
                onLoad={() => setBackgroundReady(true)}
                onError={removeBackground}
              />
            )}
            <video
              ref={videoRef}
              className={cameraStatus === "on" ? "camera-feed visible" : "camera-feed"}
              autoPlay
              muted
              playsInline
              aria-label="Live mirrored webcam feed"
            />
            <canvas
              ref={artworkCanvasRef}
              className="artwork-canvas"
              aria-label="Transparent drawing canvas"
            />
            <canvas
              ref={trackingCanvasRef}
              className="tracking-canvas"
              aria-hidden="true"
            />
            <div className="stage-shade" />

            {cameraStatus === "on" && (
              <>
                <div className="live-indicators">
                  <span className="live-badge">
                    <span className="live-dot" />
                    LIVE
                  </span>
                  <span>{handsCount} {handsCount === 1 ? "hand" : "hands"}</span>
                  <span>{fps || "—"} FPS</span>
                </div>

                <div
                  className={
                    gestureActive
                      ? "gesture-status drawing"
                      : "gesture-status"
                  }
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  <span className="gesture-icon">
                    {gestureActive ? <Check size={15} /> : <Pencil size={15} />}
                  </span>
                  <span>
                    {gestureActive
                      ? tool === "eraser"
                        ? "Erasing"
                        : isDrawing
                          ? "Drawing"
                          : "Pen ready"
                      : handsCount
                        ? "Curl your other fingers to draw"
                        : "Show your hand"}
                  </span>
                </div>
              </>
            )}

            {cameraStatus !== "on" && (
              <div className="welcome-panel">
                <div className="welcome-symbol" aria-hidden="true">
                  <span className="orbit orbit-one" />
                  <span className="orbit orbit-two" />
                  <Pencil size={27} />
                </div>
                <p className="eyebrow">INVISIBLE WHITEBOARD</p>
                <h1>Your hand is the pen.</h1>
                <p className="welcome-copy">
                  Point with your index finger, curl the others, and draw
                  directly into the air.
                </p>

                {cameraError && (
                  <div className="error-message" role="alert">
                    {cameraError}
                  </div>
                )}

                {trackerStatus === "loading" ? (
                  <div className="loading-state" role="status">
                    <LoaderCircle className="spin" size={19} />
                    <span>Preparing hand tracking…</span>
                  </div>
                ) : trackerStatus === "error" ? (
                  <button className="start-button" onClick={retryTracker}>
                    <RotateCcw size={18} />
                    Retry hand tracking
                  </button>
                ) : (
                  <button
                    className="start-button"
                    onClick={startCamera}
                    disabled={cameraStatus === "starting"}
                  >
                    {cameraStatus === "starting" ? (
                      <LoaderCircle className="spin" size={19} />
                    ) : (
                      <Camera size={19} />
                    )}
                    {cameraStatus === "starting"
                      ? "Starting camera…"
                      : cameraStatus === "error"
                        ? "Try camera again"
                        : "Start camera"}
                  </button>
                )}

                <p className="privacy-note">
                  Your video never leaves this device.
                </p>
              </div>
            )}
          </div>

          <div className="studio-footer">
            <div className="pose-guide">
              <span className="pose-number">01</span>
              <span>Index finger up</span>
              <i />
              <span className="pose-number">02</span>
              <span>Other fingers curled</span>
              <i />
              <span className="pose-number">03</span>
              <span>Move to draw</span>
            </div>

            <div className="stage-actions">
              <button
                className="footer-button"
                onClick={cameraStatus === "on" ? stopCamera : startCamera}
                disabled={trackerStatus !== "ready" || cameraStatus === "starting"}
                aria-label={
                  cameraStatus === "on" ? "Stop camera" : "Start camera"
                }
              >
                {cameraStatus === "on" ? (
                  <CameraOff size={17} />
                ) : (
                  <Camera size={17} />
                )}
                <span>{cameraStatus === "on" ? "Stop camera" : "Camera"}</span>
              </button>
              <button
                className="footer-button icon-only"
                onClick={toggleFullscreen}
                aria-label={isFullscreen ? "Exit full screen" : "Enter full screen"}
                title={isFullscreen ? "Exit full screen" : "Enter full screen"}
              >
                {isFullscreen ? (
                  <Minimize2 size={18} />
                ) : (
                  <Maximize2 size={18} />
                )}
              </button>
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}
