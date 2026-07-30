export type LandmarkPoint = { x: number; y: number; z?: number };

const PINCH_ENGAGE_RATIO = 0.3;
const PINCH_RELEASE_RATIO = 0.42;

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
  holding: boolean,
) {
  const pipThreshold = holding ? 142 : 155;
  const dipThreshold = holding ? 138 : 150;
  const reachThreshold = holding ? 1 : 1.08;

  return (
    jointAngle(landmarks[mcp], landmarks[pip], landmarks[dip]) >
      pipThreshold &&
    jointAngle(landmarks[pip], landmarks[dip], landmarks[tip]) >
      dipThreshold &&
    distance3D(landmarks[tip], landmarks[0]) >
      distance3D(landmarks[pip], landmarks[0]) * reachThreshold
  );
}

function fingerIsCurled(
  landmarks: LandmarkPoint[],
  mcp: number,
  pip: number,
  dip: number,
  tip: number,
  holding: boolean,
) {
  const pipThreshold = holding ? 160 : 145;
  const dipThreshold = holding ? 165 : 150;
  const reachThreshold = holding ? 1.18 : 1.08;
  const cues = [
    jointAngle(landmarks[mcp], landmarks[pip], landmarks[dip]) <
      pipThreshold,
    jointAngle(landmarks[pip], landmarks[dip], landmarks[tip]) <
      dipThreshold,
    distance3D(landmarks[tip], landmarks[0]) <
      distance3D(landmarks[pip], landmarks[0]) * reachThreshold,
  ];

  return cues.filter(Boolean).length >= 2;
}

export function isPenPose(
  landmarks: LandmarkPoint[],
  options: { holding?: boolean } = {},
) {
  if (landmarks.length !== 21) return false;
  const holding = options.holding ?? false;

  const otherFingersAreCurled =
    fingerIsCurled(landmarks, 9, 10, 11, 12, holding) &&
    fingerIsCurled(landmarks, 13, 14, 15, 16, holding) &&
    fingerIsCurled(landmarks, 17, 18, 19, 20, holding);
  if (!otherFingersAreCurled) return false;

  const indexIsPointing = fingerIsExtended(
    landmarks,
    5,
    6,
    7,
    8,
    holding,
  );
  const palmScale = Math.max(
    (distance3D(landmarks[5], landmarks[17]) +
      distance3D(landmarks[0], landmarks[9])) /
      2,
    0.0001,
  );
  const pinchRatio =
    distance3D(landmarks[4], landmarks[8]) / palmScale;
  const pinchThreshold = holding
    ? PINCH_RELEASE_RATIO
    : PINCH_ENGAGE_RATIO;
  const indexPipAngle = jointAngle(
    landmarks[5],
    landmarks[6],
    landmarks[7],
  );
  const indexDipAngle = jointAngle(
    landmarks[6],
    landmarks[7],
    landmarks[8],
  );
  const indexReach =
    distance3D(landmarks[5], landmarks[8]) / palmScale;
  const pinchShapeIsValid = holding
    ? indexPipAngle > 55 && indexDipAngle > 90 && indexReach > 0.32
    : indexPipAngle > 70 && indexDipAngle > 105 && indexReach > 0.45;
  const indexIsPinching =
    pinchRatio <= pinchThreshold && pinchShapeIsValid;

  return indexIsPointing || indexIsPinching;
}
