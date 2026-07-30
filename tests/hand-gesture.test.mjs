import assert from "node:assert/strict";
import test from "node:test";
import { isPenPose } from "../app/hand-gesture.ts";

function curledHand() {
  const landmarks = Array.from({ length: 21 }, () => ({
    x: 0,
    y: 0,
    z: 0,
  }));

  landmarks[0] = { x: 0, y: 0, z: 0 };
  landmarks[1] = { x: -0.16, y: 0.12, z: 0 };
  landmarks[2] = { x: -0.22, y: 0.22, z: 0 };
  landmarks[3] = { x: -0.12, y: 0.34, z: 0 };
  landmarks[4] = { x: 0.24, y: 0.41, z: 0 };

  landmarks[5] = { x: 0, y: 0.3, z: 0 };
  landmarks[6] = { x: 0, y: 0.54, z: 0 };
  landmarks[7] = { x: 0.18, y: 0.54, z: 0 };
  landmarks[8] = { x: 0.22, y: 0.4, z: 0 };

  landmarks[9] = { x: 0.15, y: 0.28, z: 0 };
  landmarks[10] = { x: 0.15, y: 0.5, z: 0 };
  landmarks[11] = { x: 0.28, y: 0.45, z: 0 };
  landmarks[12] = { x: 0.18, y: 0.35, z: 0 };

  landmarks[13] = { x: 0.3, y: 0.24, z: 0 };
  landmarks[14] = { x: 0.3, y: 0.45, z: 0 };
  landmarks[15] = { x: 0.42, y: 0.4, z: 0 };
  landmarks[16] = { x: 0.31, y: 0.3, z: 0 };

  landmarks[17] = { x: 0.45, y: 0.18, z: 0 };
  landmarks[18] = { x: 0.45, y: 0.35, z: 0 };
  landmarks[19] = { x: 0.55, y: 0.3, z: 0 };
  landmarks[20] = { x: 0.45, y: 0.23, z: 0 };

  return landmarks;
}

test("accepts a thumb-index pinch with the other fingers curled", () => {
  assert.equal(isPenPose(curledHand()), true);
});

test("keeps the original extended-index pen pose", () => {
  const landmarks = curledHand();
  landmarks[4] = { x: -0.35, y: 0.45, z: 0 };
  landmarks[5] = { x: 0, y: 0.3, z: 0 };
  landmarks[6] = { x: 0, y: 0.52, z: 0 };
  landmarks[7] = { x: 0, y: 0.74, z: 0 };
  landmarks[8] = { x: 0, y: 0.98, z: 0 };

  assert.equal(isPenPose(landmarks), true);
});

test("uses a wider release threshold to prevent pinch flicker", () => {
  const landmarks = curledHand();
  landmarks[4] = { x: 0.38, y: 0.4, z: 0 };

  assert.equal(isPenPose(landmarks), false);
  assert.equal(isPenPose(landmarks, { holding: true }), true);
});

test("does not draw when the remaining fingers are open", () => {
  const landmarks = curledHand();
  for (const [mcp, pip, dip, tip, x] of [
    [9, 10, 11, 12, 0.15],
    [13, 14, 15, 16, 0.3],
    [17, 18, 19, 20, 0.45],
  ]) {
    landmarks[mcp] = { x, y: 0.25, z: 0 };
    landmarks[pip] = { x, y: 0.48, z: 0 };
    landmarks[dip] = { x, y: 0.71, z: 0 };
    landmarks[tip] = { x, y: 0.94, z: 0 };
  }

  assert.equal(isPenPose(landmarks), false);
});
