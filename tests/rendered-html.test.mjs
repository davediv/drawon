import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Drawon application shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Drawon — Draw in the air<\/title>/i);
  assert.match(html, /Your hand is the pen\./);
  assert.match(html, /Preparing hand tracking/);
  assert.match(html, /Save PNG/);
  assert.match(html, /Transparent drawing canvas/);
  assert.match(html, /On-device tracking/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("includes webcam tracking and complete drawing controls", async () => {
  const [page, gesture, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/hand-gesture.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /^"use client";/);
  assert.match(page, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(page, /detectForVideo/);
  assert.match(page, /numHands:\s*2/);
  assert.match(page, /holding:/);
  assert.match(gesture, /PINCH_ENGAGE_RATIO/);
  assert.match(gesture, /fingerIsExtended/);
  assert.match(page, /destination-out/);
  assert.match(page, /redoStackRef/);
  assert.match(page, /toBlob/);
  assert.match(page, /type="color"/);
  assert.match(page, /type="range"/);
  assert.match(page, /accept="image\/\*"/);
  assert.match(layout, /Drawon — Draw in the air/);
  assert.match(packageJson, /"@mediapipe\/tasks-vision": "1\.0\.0"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);

  await assert.rejects(
    access(new URL("../app/_sites-preview", import.meta.url)),
  );
});
