import { test, expect } from "@playwright/test";
import { frameAtTime, frameIntervalMs, frameTimeMs, nearestFrameIndex, steppedFrameTimeMs } from "../lib/frame-time";
import fixture from "./fixtures/compare.json";

const frames = [0, 80, 310, 600, 940, 1320, 1580, 1800].map((t_ms, frame_idx) => ({ frame_idx, t_ms }));

test("frame timestamp mapping covers variable intervals, boundaries and missing-sequence fallback", () => {
  expect(frameAtTime(frames, 309)?.frame_idx).toBe(1);
  expect(frameAtTime(frames, 310)?.frame_idx).toBe(2);
  expect(nearestFrameIndex(frames, 595, 30)).toBe(3);
  expect(frameTimeMs(frames, 3, 30)).toBe(600);
  expect(frameTimeMs(frames, 8, 30, 1900)).toBe(1900);
  expect(steppedFrameTimeMs(frames, 310, 1, 30)).toBe(600);
  expect(steppedFrameTimeMs(frames, 310, -1, 30)).toBe(80);
  expect(steppedFrameTimeMs(frames, 80, 10, 30)).toBe(1800);
  expect(steppedFrameTimeMs(frames, 80, -10, 30)).toBe(0);
  expect(frameIntervalMs(frames, 320, 30)).toBe(290);
  expect(frameAtTime([], 0)).toBeNull();
  expect(frameTimeMs([], 3, 10)).toBe(300);
  expect(steppedFrameTimeMs([], 200, 1, 10)).toBe(300);
});

test("VFR workbench steps real frames, stores marker timestamps and renders and drags phase boundaries", async ({ page }) => {
  const writes: Record<string, unknown>[] = [];
  await page.route("**/api/v1/compare/comparisons/vfr", async (route) => {
    if (route.request().method() === "PATCH") writes.push(route.request().postDataJSON());
    await route.continue();
  });
  await page.goto("/compare/vfr");
  await expect(page.getByText("Comparison workbench")).toBeVisible();
  await expect.poll(() => page.locator("video").evaluateAll((videos) => videos.every((video) => (video as HTMLVideoElement).readyState >= 2))).toBe(true);
  const clock = page.getByTestId("comparison-clock");
  await page.getByRole("button", { name: "+1", exact: true }).click();
  await expect(clock).toContainText("0.080s");
  await page.getByRole("button", { name: "+1", exact: true }).click();
  await expect(clock).toContainText("0.310s");
  await page.getByRole("button", { name: /\+ Marker/ }).click();
  await page.getByPlaceholder("For example: wrist opens late").fill("VFR 出手帧");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect.poll(() => writes.find((write) => write.markers)?.markers).toMatchObject([{ frame: 2, t_ms: 310, text: "VFR 出手帧" }]);
  await expect(page.getByText("出手: B later 1 frame (+110 ms)", { exact: true })).toBeVisible();
  const phaseA = page.getByTitle("准备: frames 0–1", { exact: true });
  const phaseB = page.getByTitle("准备: frames 0–2", { exact: true });
  expect(await phaseA.evaluate((element: HTMLElement) => parseFloat(element.style.width))).toBeCloseTo(310 / 1800 * 100, 3);
  expect(await phaseB.evaluate((element: HTMLElement) => parseFloat(element.style.width))).toBeCloseTo(420 / 1800 * 100, 3);
  await page.keyboard.press("Shift+ArrowRight");
  await expect(clock).toContainText("1.800s");
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(clock).toContainText("0.000s");
  const handle = page.getByLabel("A 准备 phase boundary");
  await handle.scrollIntoViewIfNeeded();
  const handleBox = (await handle.boundingBox())!;
  const trackBox = (await page.getByLabel("A phase timeline").boundingBox())!;
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(trackBox.x + trackBox.width * 600 / 1800, handleBox.y + handleBox.height / 2);
  await page.mouse.up();
  await expect.poll(() => writes.find((write) => write.phases_a)?.phases_a).toEqual([
    { phase: "准备", start_frame: 0, end_frame: 2 }, { phase: "出手", start_frame: 3, end_frame: 7 },
  ]);
  await expect.poll(() => page.getByTitle("准备: frames 0–2", { exact: true }).first().evaluate((element: HTMLElement) => parseFloat(element.style.width))).toBeCloseTo(600 / 1800 * 100, 3);
});

test("a marker at an alignment inside a frame stays visible at the current time and records the actual frame", async ({ page }) => {
  const state = { ...fixture.comparison, comparison_id: "nonframeoffset", temporal: { ...fixture.comparison.temporal, offset_ms_a: 250 } };
  const writes: Record<string, unknown>[] = [];
  await page.route("**/api/v1/compare/comparisons/nonframeoffset", async (route) => {
    if (route.request().method() === "PATCH") {
      const patch = route.request().postDataJSON();
      writes.push(patch);
      Object.assign(state, patch);
    }
    await route.fulfill({ json: state });
  });
  await page.goto("/compare/nonframeoffset");
  await expect.poll(() => page.locator("video").first().evaluate((video: HTMLVideoElement) => Math.round(video.currentTime * 1000))).toBe(250);
  await page.getByRole("button", { name: /\+ Marker/ }).click();
  await page.getByPlaceholder("For example: wrist opens late").fill("非帧点起点");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect.poll(() => writes.find((write) => write.markers)?.markers).toMatchObject([{ frame: 2, t_ms: 250, text: "非帧点起点" }]);
  const marker = page.getByTitle("非帧点起点 (click to seek, double-click to delete)").first();
  await expect(marker).toBeVisible();
  expect(await marker.evaluate((element: HTMLElement) => element.style.left)).toBe("0%");
});
