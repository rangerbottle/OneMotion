import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";

const clip = readFileSync(resolve(process.cwd(), "tests/fixtures/compare-a.webm")).toString("base64");

type RecordingState = {
  created: string[];
  revoked: string[];
  cameraStarts: number;
  stopped: number;
  emptyNext: boolean;
  failNext: boolean;
};

async function fakeRecorder(page: Page) {
  await page.addInitScript((bytes) => {
    const state: RecordingState = { created: [], revoked: [], cameraStarts: 0, stopped: 0, emptyNext: false, failNext: false };
    Object.assign(window, { recordingTest: state });
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { const url = create(blob); state.created.push(url); return url; };
    URL.revokeObjectURL = (url) => { state.revoked.push(url); revoke(url); };
    navigator.mediaDevices.getUserMedia = async () => {
      state.cameraStarts++;
      const canvas = document.createElement("canvas");
      canvas.width = 160; canvas.height = 90;
      const stream = canvas.captureStream();
      const context = canvas.getContext("2d")!;
      const pump = setInterval(() => { context.fillStyle = "#123456"; context.fillRect(0, 0, 160, 90); }, 30);
      for (const track of stream.getTracks()) {
        const stop = track.stop.bind(track);
        track.stop = () => { state.stopped++; clearInterval(pump); stop(); };
      }
      return stream;
    };
    class Recorder {
      static isTypeSupported() { return true; }
      state = "inactive";
      mimeType = "video/webm";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror = null;
      start() {
        if (state.failNext) { state.failNext = false; throw new Error("Recording unavailable"); }
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        const empty = state.emptyNext;
        state.emptyNext = false;
        queueMicrotask(() => {
          const data = empty ? new Blob() : new Blob([Uint8Array.from(atob(bytes), (character) => character.charCodeAt(0))], { type: this.mimeType });
          this.ondataavailable?.({ data });
          this.onstop?.();
        });
      }
    }
    Object.assign(window, { MediaRecorder: Recorder });
  }, clip);
}

async function recordShot(page: Page) {
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
}

test("recorded shots can be reviewed and replaced without reopening the camera or leaking previews", async ({ page }) => {
  await fakeRecorder(page);
  await page.goto("/record");
  await page.getByRole("button", { name: "Enable camera" }).click();
  await recordShot(page);
  const video = page.locator("video");
  await expect(video).toHaveAttribute("src", /^blob:/);
  await expect(video).toHaveJSProperty("srcObject", null);
  await expect(video).toHaveJSProperty("controls", true);
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => Number.isFinite(element.duration) && element.duration > 0)).toBe(true);
  const first = await video.getAttribute("src");
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await expect(video).not.toHaveAttribute("src", /^blob:/);
  await expect(video).toHaveJSProperty("controls", false);
  expect(await video.evaluate((element: HTMLVideoElement) => element.srcObject instanceof MediaStream)).toBe(true);
  expect(await page.evaluate(() => (window as typeof window & { recordingTest: RecordingState }).recordingTest.revoked)).toContain(first);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(video).toHaveAttribute("src", /^blob:/);
  const second = await video.getAttribute("src");
  expect(second).not.toBe(first);
  expect(await page.evaluate(() => (window as typeof window & { recordingTest: RecordingState }).recordingTest.cameraStarts)).toBe(1);
  await page.getByRole("link", { name: "Upload a clip", exact: true }).click();
  await expect(page).toHaveURL(/\/upload$/);
  await expect.poll(() => page.evaluate(() => (window as typeof window & { recordingTest: RecordingState }).recordingTest.stopped)).toBe(1);
  expect(await page.evaluate(() => (window as typeof window & { recordingTest: RecordingState }).recordingTest.revoked)).toContain(second);
});

test("an empty recording offers a visible retry and cannot be analyzed", async ({ page }) => {
  await fakeRecorder(page);
  await page.goto("/record");
  await page.getByRole("button", { name: "Enable camera" }).click();
  await page.evaluate(() => { (window as typeof window & { recordingTest: RecordingState }).recordingTest.emptyNext = true; });
  await recordShot(page);
  await expect(page.getByRole("status")).toContainText("recording is empty");
  await expect(page.getByRole("button", { name: "Analyze my shot" })).toHaveCount(0);
  await expect(page.locator("video")).not.toHaveAttribute("src", /^blob:/);
  await recordShot(page);
  await expect(page.getByRole("button", { name: "Analyze my shot" })).toBeEnabled();
  await expect(page.locator("video")).toHaveAttribute("src", /^blob:/);
  await expect(page.getByRole("status")).toHaveCount(0);
});

test("a failed re-record does not leave an empty clip in the recorded state", async ({ page }) => {
  await fakeRecorder(page);
  await page.goto("/record");
  await page.getByRole("button", { name: "Enable camera" }).click();
  await recordShot(page);
  await expect(page.getByRole("button", { name: "Analyze my shot" })).toBeEnabled();
  await page.evaluate(() => { (window as typeof window & { recordingTest: RecordingState }).recordingTest.failNext = true; });
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Video recording is unavailable");
  await expect(page.getByRole("button", { name: "Analyze my shot" })).toHaveCount(0);
  await expect(page.locator("video")).toHaveJSProperty("controls", false);
  await recordShot(page);
  await expect(page.getByRole("button", { name: "Analyze my shot" })).toBeEnabled();
});
