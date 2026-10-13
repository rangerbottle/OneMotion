import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { test, expect, type Page, type Request } from "@playwright/test";
import type { HomeCourtSourceInput } from "../lib/api";

const session = resolve(process.cwd(), "tests/fixtures/homecourt-session.webm");
const original = readFileSync(session);
const originalHash = createHash("sha256").update(original).digest("hex");

function multipart(request: Request) {
  const boundary = request.headers()["content-type"].match(/boundary=(?:"([^"]+)"|([^;]+))/);
  if (!boundary) throw new Error("Expected a multipart request");
  const fields: Record<string, { filename?: string; bytes: Buffer }> = {};
  for (const part of request.postDataBuffer()!.toString("latin1").split(`--${boundary[1] ?? boundary[2]}`)) {
    const split = part.indexOf("\r\n\r\n");
    if (split < 0) continue;
    const header = part.slice(0, split);
    const name = header.match(/\bname="([^"]+)"/)?.[1];
    if (!name) continue;
    fields[name] = { filename: header.match(/\bfilename="([^"]+)"/)?.[1], bytes: Buffer.from(part.slice(split + 4).replace(/\r\n$/, ""), "latin1") };
  }
  return fields;
}

async function loadSession(page: Page) {
  await page.locator('input[type="file"]').setInputFiles(session);
  await expect(page.getByRole("spinbutton", { name: "End time (seconds)" })).toBeVisible();
  await expect(page.locator("video")).toHaveJSProperty("duration", 20);
}

async function selectRange(page: Page, start: string, end: string) {
  await page.getByRole("spinbutton", { name: "Start time (seconds)" }).fill(start);
  await page.getByRole("spinbutton", { name: "End time (seconds)" }).fill(end);
}

test("HomeCourt imports a selected interval from the original long file with unknown timing by default", async ({ page }) => {
  let posted: ReturnType<typeof multipart> | undefined;
  await page.route("**/api/v1/analysis", async (route) => { posted = multipart(route.request()); await route.continue(); });
  await page.goto("/homecourt");
  await loadSession(page);
  await expect(page.getByRole("combobox", { name: "Playback speed" })).toHaveValue("unknown");
  await expect(page.getByRole("checkbox", { name: "Loop selection" })).not.toBeChecked();
  await selectRange(page, "12", "18");
  await page.getByLabel("Practice time (optional)").fill("2026-10-04T09:30");
  await page.getByLabel("Camera label (optional)").fill("右侧固定机位");
  const recordedAt = await page.evaluate(() => new Date("2026-10-04T09:30").toISOString());
  await page.getByRole("checkbox", { name: /I confirm I am the only person/ }).check();
  const submittedResponse = page.waitForResponse((response) => response.url().endsWith("/api/v1/analysis") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Analyze selected shot" }).click();
  const submitted = await (await submittedResponse).json();
  await expect(page).toHaveURL(/\/analysis\/homecourt\d+$/);
  const provenance = page.getByRole("region", { name: "Practice source", exact: true });
  await expect(provenance).toContainText("homecourt-session.webm");
  await expect(provenance).toContainText("右侧固定机位");
  await expect(provenance).toContainText("Playback speed unknown");
  await expect(provenance).toContainText("Timing and velocity conclusions are disabled");
  expect(Object.keys(posted!).sort()).toEqual(["source", "video"]);
  expect(posted!.video.filename).toBe("homecourt-session.webm");
  // Chromium's intercepted multipart body omits file bytes. The fixture server
  // hashes the actual received File, which must match the full original video.
  expect(submitted.source.original_sha256).toBe(originalHash);
  expect(JSON.parse(posted!.source.bytes.toString())).toEqual({
    provider: "homecourt", start_ms: 12000, end_ms: 18000, timing_mode: "unknown", recorded_at: recordedAt, camera_label: "右侧固定机位",
  });
});

test("HomeCourt rejects an over-12-second selection and preserves an explicit slow-motion declaration", async ({ page }) => {
  const sources: HomeCourtSourceInput[] = [];
  await page.route("**/api/v1/analysis", async (route) => { sources.push(JSON.parse(multipart(route.request()).source.bytes.toString())); await route.continue(); });
  await page.goto("/homecourt");
  await loadSession(page);
  await selectRange(page, "0", "13");
  await page.getByRole("checkbox", { name: /I confirm I am the only person/ }).check();
  await expect(page.getByRole("region", { name: "HomeCourt clip selection" }).getByRole("alert")).toContainText("no more than 12 seconds");
  await expect(page.getByRole("button", { name: "Analyze selected shot" })).toBeDisabled();
  expect(sources).toHaveLength(0);
  await page.getByRole("spinbutton", { name: "End time (seconds)" }).fill("12");
  await page.getByRole("combobox", { name: "Playback speed" }).selectOption("slow_motion");
  await expect(page.getByRole("checkbox", { name: /I confirm I am the only person/ })).not.toBeChecked();
  await page.getByRole("checkbox", { name: /I confirm I am the only person/ }).check();
  await page.getByRole("button", { name: "Analyze selected shot" }).click();
  await expect(page).toHaveURL(/\/analysis\/homecourt\d+$/);
  expect(sources).toEqual([{ provider: "homecourt", start_ms: 0, end_ms: 12000, timing_mode: "slow_motion" }]);
});

test("HomeCourt requires a normalized person rectangle and confirmation, and recovers from pointer cancellation", async ({ page }) => {
  let source: HomeCourtSourceInput | undefined;
  await page.route("**/api/v1/analysis", async (route) => { source = JSON.parse(multipart(route.request()).source.bytes.toString()); await route.continue(); });
  await page.goto("/homecourt");
  await loadSession(page);
  await page.getByRole("combobox", { name: "People in this shot?" }).selectOption("multiple");
  const confirmation = page.getByRole("checkbox", { name: /I confirm the rectangle selects me/ });
  await expect(confirmation).toBeDisabled();
  await expect(page.getByRole("button", { name: "Analyze selected shot" })).toBeDisabled();
  await page.getByRole("button", { name: "Draw person region", exact: true }).click();
  const overlay = page.getByRole("img", { name: "Drag a rectangle to select yourself" });
  await overlay.scrollIntoViewIfNeeded();
  let box = (await overlay.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.1);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await overlay.dispatchEvent("pointercancel", { pointerId: 1, pointerType: "mouse" });
  await page.mouse.up();
  await expect(overlay).toHaveCount(0);
  await expect(page.getByLabel("Selected person region")).toHaveCount(0);
  await expect(confirmation).toBeDisabled();
  await page.getByRole("button", { name: "Draw person region", exact: true }).click();
  await overlay.scrollIntoViewIfNeeded();
  box = (await overlay.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.1);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.9);
  await page.mouse.up();
  await expect(confirmation).toBeEnabled();
  await expect(page.getByRole("button", { name: "Analyze selected shot" })).toBeDisabled();
  await confirmation.check();
  await page.getByRole("button", { name: "Analyze selected shot" }).click();
  await expect(page).toHaveURL(/\/analysis\/homecourt\d+$/);
  expect(source!.subject_roi!.x).toBeCloseTo(0.25, 2);
  expect(source!.subject_roi!.y).toBeCloseTo(0.1, 2);
  expect(source!.subject_roi!.width).toBeCloseTo(0.5, 2);
  expect(source!.subject_roi!.height).toBeCloseTo(0.8, 2);
});

test("a failed HomeCourt preview remains a non-fatal message and does not invalidate the confirmed upload", async ({ page }) => {
  await page.goto("/homecourt");
  await loadSession(page);
  await page.locator("video").evaluate((video: HTMLVideoElement) => { video.play = () => Promise.reject(new DOMException("Playback blocked", "NotAllowedError")); });
  await page.getByRole("button", { name: "Preview selection" }).click();
  await expect(page.getByRole("status")).toContainText("still submit a confirmed selection");
  await expect(page.getByRole("region", { name: "HomeCourt clip selection" }).getByRole("alert")).toHaveCount(0);
  await page.getByRole("checkbox", { name: /I confirm I am the only person/ }).check();
  await page.getByRole("button", { name: "Analyze selected shot" }).click();
  await expect(page).toHaveURL(/\/analysis\/homecourt\d+$/);
});

test("HomeCourt history comparison imports two independently selected shots and locks navigation while uploading", async ({ page }) => {
  const uploads: ReturnType<typeof multipart>[] = [];
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  let comparisonInput: Record<string, string> | undefined;
  await page.route("**/api/v1/compare/players/p1/clips", async (route) => {
    uploads.push(multipart(route.request()));
    if (uploads.length === 2) await delayed;
    await route.continue();
  });
  await page.route("**/api/v1/compare/comparisons", async (route) => {
    if (route.request().method() === "POST") comparisonInput = route.request().postDataJSON();
    await route.continue();
  });
  await page.goto("/compare/new?source=homecourt&player=p1&template=t1");
  await loadSession(page);
  await selectRange(page, "1", "4");
  await page.getByRole("checkbox", { name: /I confirm I am the only person/ }).check();
  const baselineResponse = page.waitForResponse((response) => response.url().endsWith("/players/p1/clips") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Upload selected shot" }).click();
  const baseline = await (await baselineResponse).json();
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.locator("video")).toHaveCount(0);
  await loadSession(page);
  await selectRange(page, "12", "16");
  await page.getByRole("combobox", { name: "Playback speed" }).selectOption("slow_motion");
  await page.getByRole("checkbox", { name: /I confirm I am the only person/ }).check();
  const comparisonResponse = page.waitForResponse((response) => response.url().endsWith("/players/p1/clips") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Upload selected shot" }).click();
  await expect.poll(() => uploads.length).toBe(2);
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
  await expect(page.locator('input[type="file"]')).toBeDisabled();
  release();
  const comparison = await (await comparisonResponse).json();
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByText(/✅ Camera matched/)).toBeVisible();
  expect(comparisonInput).toMatchObject({ player_id: "p1", template_id: "t1", baseline_clip_id: baseline.clip_id, comparison_clip_id: comparison.clip_id });
  expect(uploads.map((upload) => upload.kind.bytes.toString())).toEqual(["baseline", "comparison"]);
  expect([baseline.source.original_sha256, comparison.source.original_sha256]).toEqual([originalHash, originalHash]);
  expect(uploads.map((upload) => JSON.parse(upload.source.bytes.toString()))).toEqual([
    { provider: "homecourt", start_ms: 1000, end_ms: 4000, timing_mode: "unknown" },
    { provider: "homecourt", start_ms: 12000, end_ms: 16000, timing_mode: "slow_motion" },
  ]);
});
