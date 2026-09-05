import { mkdir, writeFile, truncate } from "node:fs/promises";
import { dirname } from "node:path";
import { recordingFilename } from "../lib/clip";
import { test, expect } from "@playwright/test";

test("OneMotion branding", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/OneMotion/);
  await expect(page.getByRole("link", { name: "OneMotion", exact: true })).toBeVisible();
});

test("oversized upload never submits", async ({ page }, testInfo) => {
  let submitted = false;
  await page.route("**/api/v1/analysis", route => { submitted = true; return route.abort(); });
  await page.goto("/upload");
  const large = testInfo.outputPath("large.mp4");
  await mkdir(dirname(large), {recursive: true});
  await writeFile(large, "");
  await truncate(large, 50 * 1024 * 1024 + 1);
  await page.locator('input[type="file"]').setInputFiles(large);
  await expect(page.getByRole("status")).toContainText("exceeds 50 MB");
  await expect(page.getByRole("button", {name:"Analyze my shot"})).toBeDisabled();
  expect(submitted).toBe(false);
});

test("late camera authorization stops all tracks after navigation", async ({ page }) => {
  await page.goto("/record");
  await page.evaluate(() => {
    const state = window as typeof window & { grant?: () => void; stopped?: number };
    state.stopped = 0;
    navigator.mediaDevices.getUserMedia = () => new Promise(resolve => {
      state.grant = () => {
        const stream = document.createElement("canvas").captureStream();
        for (const track of stream.getTracks()) {
          const stop = track.stop.bind(track);
          track.stop = () => { state.stopped!++; stop(); };
        }
        resolve(stream);
      };
    });
  });
  await page.getByRole("button", {name:"Enable camera"}).click();
  await expect(page.getByRole("button", {name:"Waiting for camera…"})).toBeDisabled();
  await page.getByRole("link", {name:"Upload a clip"}).click();
  await expect(page).toHaveURL(/upload/);
  await page.evaluate(() => (window as typeof window & {grant: () => void}).grant());
  await expect.poll(() => page.evaluate(() => (window as typeof window & {stopped:number}).stopped)).toBe(1);
});

test("expired replay preserves the report and offers a new shot", async ({ page }) => {
  await page.goto("/analysis/expired");
  await expect(page.getByRole("status")).toContainText("replay has expired");
  await expect(page.getByRole("button", {name:"Retry replay"})).toHaveCount(0);
  await expect(page.getByRole("link", {name:"Upload a new shot"})).toBeVisible();
});

test("video expiry is visible even when replay JSON succeeds", async ({ page }) => {
  await page.goto("/analysis/demo");
  await expect(page.getByRole("alert").first()).toContainText("replay has expired");
  await expect(page.getByRole("button", {name:"Reload replay"})).toHaveCount(0);
  await expect(page.getByRole("link", {name:"Upload a new shot"}).first()).toBeVisible();
});

test("report errors have an actionable fallback", async ({ page }) => {
  await page.goto("/analysis/missing");
  await expect(page.getByRole("heading", {name:"Analysis not found"})).toBeVisible();
  await page.goto("/analysis/gone");
  await expect(page.getByRole("heading", {name:"This analysis is no longer available"})).toBeVisible();
  await page.goto("/analysis/unavailable");
  await expect(page.getByRole("button", {name:"Try again"})).toBeVisible();
});

test("offline replay can be retried", async ({ page }) => {
  let fail = true;
  await page.route("**/api/v1/analysis/demo/replay", route => fail ? route.abort() : route.continue());
  await page.goto("/analysis/demo");
  await expect(page.getByRole("status")).toContainText("Check your connection");
  fail = false;
  await page.getByRole("button", {name:"Retry replay"}).click();
  await expect(page.getByRole("heading", {name:"Video + biomechanics replay"})).toBeVisible();
});

test("independent replay stops at the window and paused overlays redraw", async ({ page }) => {
  // Keep media pending; source-frame events below simulate a video longer than the shot.
  await page.route("**/video", () => {});
  await page.goto("/analysis/demo");
  await expect(page.getByRole("heading", {name:"Video + biomechanics replay"})).toBeVisible();
  await page.getByRole("checkbox", {name:"Sync clips"}).uncheck();
  await page.locator("video").first().evaluate((video: HTMLVideoElement) => {
    Object.defineProperty(video, "currentTime", {value: .7, writable: true, configurable: true});
    video.dispatchEvent(new Event("timeupdate"));
  });
  await expect(page.getByRole("slider", {name:"You replay position"})).toHaveValue("400");
  expect(await page.locator("video").first().evaluate((video: HTMLVideoElement) => video.currentTime)).toBe(.4);
  await page.getByRole("checkbox", {name:"Skeleton", exact:true}).uncheck();
  await page.getByRole("checkbox", {name:"Angles", exact:true}).uncheck();
  const coloredPixels = () => page.locator("canvas").first().evaluate((canvas: HTMLCanvasElement) =>
    canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data.some(value => value !== 0));
  await expect.poll(coloredPixels).toBe(false);
  await page.getByRole("checkbox", {name:"Angles", exact:true}).check();
  await expect.poll(coloredPixels).toBe(true);
});


test("recording locks the submitted clip and preserves its container type", async ({ page }) => {
  expect(recordingFilename("video/mp4;codecs=avc1")).toBe("shot.mp4");
  await page.goto("/record");
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 160; canvas.height = 90;
      const context = canvas.getContext("2d")!;
      setInterval(() => { context.fillStyle = "#123456"; context.fillRect(0, 0, 160, 90); }, 30);
      return canvas.captureStream(30);
    };
  });
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let filename = "";
  await page.route("**/api/v1/analysis", async route => {
    filename = route.request().postDataBuffer()!.toString("latin1");
    await pending;
    await route.fulfill({json: {analysis_id: "demo"}});
  });
  await page.getByRole("button", {name:"Enable camera"}).click();
  await page.getByRole("button", {name:"Record", exact:true}).click();
  await page.waitForTimeout(500); // Produce actual browser-encoded video frames.
  await page.getByRole("button", {name:"Stop", exact:true}).click();
  await page.getByRole("button", {name:"Analyze my shot"}).click();
  await expect(page.getByRole("button", {name:"Record", exact:true})).toBeDisabled();
  await expect.poll(() => filename).toContain('filename="shot.webm"');
  finish();
  await expect(page).toHaveURL(/analysis\/demo/);
});
