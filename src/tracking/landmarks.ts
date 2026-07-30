/** MediaPipe hand landmark indices (21-point model). */
export const LM = {
  WRIST: 0,

  THUMB_CMC: 1,
  THUMB_MCP: 2,
  THUMB_IP: 3,
  THUMB_TIP: 4,

  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_DIP: 7,
  INDEX_TIP: 8,

  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_DIP: 11,
  MIDDLE_TIP: 12,

  RING_MCP: 13,
  RING_PIP: 14,
  RING_DIP: 15,
  RING_TIP: 16,

  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_DIP: 19,
  PINKY_TIP: 20,
} as const;

export type FingerName = 'thumb' | 'index' | 'middle' | 'ring' | 'pinky';

/** [mcp, pip, dip, tip] per finger; the thumb uses [cmc, mcp, ip, tip]. */
export const FINGER_JOINTS: Record<FingerName, readonly [number, number, number, number]> = {
  thumb: [LM.THUMB_CMC, LM.THUMB_MCP, LM.THUMB_IP, LM.THUMB_TIP],
  index: [LM.INDEX_MCP, LM.INDEX_PIP, LM.INDEX_DIP, LM.INDEX_TIP],
  middle: [LM.MIDDLE_MCP, LM.MIDDLE_PIP, LM.MIDDLE_DIP, LM.MIDDLE_TIP],
  ring: [LM.RING_MCP, LM.RING_PIP, LM.RING_DIP, LM.RING_TIP],
  pinky: [LM.PINKY_MCP, LM.PINKY_PIP, LM.PINKY_DIP, LM.PINKY_TIP],
};

/** Bone pairs for the skeleton overlay, grouped so the index chain can be lit differently. */
export const PALM_BONES: ReadonlyArray<readonly [number, number]> = [
  [LM.WRIST, LM.THUMB_CMC],
  [LM.WRIST, LM.INDEX_MCP],
  [LM.WRIST, LM.PINKY_MCP],
  [LM.INDEX_MCP, LM.MIDDLE_MCP],
  [LM.MIDDLE_MCP, LM.RING_MCP],
  [LM.RING_MCP, LM.PINKY_MCP],
];

export const FINGER_BONES: Record<FingerName, ReadonlyArray<readonly [number, number]>> = {
  thumb: [
    [LM.THUMB_CMC, LM.THUMB_MCP],
    [LM.THUMB_MCP, LM.THUMB_IP],
    [LM.THUMB_IP, LM.THUMB_TIP],
  ],
  index: [
    [LM.INDEX_MCP, LM.INDEX_PIP],
    [LM.INDEX_PIP, LM.INDEX_DIP],
    [LM.INDEX_DIP, LM.INDEX_TIP],
  ],
  middle: [
    [LM.MIDDLE_MCP, LM.MIDDLE_PIP],
    [LM.MIDDLE_PIP, LM.MIDDLE_DIP],
    [LM.MIDDLE_DIP, LM.MIDDLE_TIP],
  ],
  ring: [
    [LM.RING_MCP, LM.RING_PIP],
    [LM.RING_PIP, LM.RING_DIP],
    [LM.RING_DIP, LM.RING_TIP],
  ],
  pinky: [
    [LM.PINKY_MCP, LM.PINKY_PIP],
    [LM.PINKY_PIP, LM.PINKY_DIP],
    [LM.PINKY_DIP, LM.PINKY_TIP],
  ],
};
