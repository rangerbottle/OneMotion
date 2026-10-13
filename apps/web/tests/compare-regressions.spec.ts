import { test, expect } from "@playwright/test";
import fixture from "./fixtures/compare.json";

test("cross-origin decoded videos redraw while paused and use native B dimensions", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/compare/render");
  await expect(page.getByText("Comparison workbench")).toBeVisible();
  await expect.poll(() => page.locator("video").evaluateAll(videos => videos.every(v => (v as HTMLVideoElement).readyState >= 2))).toBe(true);
  const pixel = () => page.locator("canvas").first().evaluate((canvas: HTMLCanvasElement) =>
    [...canvas.getContext("2d")!.getImageData(75, 50, 1, 1).data]);
  // Green at this point becomes gray in difference view; red would reveal double scaling.
  await expect.poll(async () => (await pixel())[1]).toBeGreaterThan(140);
  await page.getByRole("button", { name: /Difference/ }).click();
  await expect.poll(async () => { const p = await pixel(); return p[0] === p[1] && p[1] === p[2] && p[3] === 255; }).toBe(true);
  await page.getByRole("button", { name: /Split/ }).click();
  await expect(page.locator("canvas.absolute")).toHaveCount(2);
  await expect(page.locator("canvas").nth(1)).toHaveAttribute("width", "48");
  await expect.poll(() => page.locator("canvas").nth(1).evaluate((canvas: HTMLCanvasElement) => canvas.getContext("2d")!.getImageData(35, 20, 1, 1).data[1])).toBeGreaterThan(140);
  expect(errors).toEqual([]);
});

test("workbench retry repeats the client load after a network failure", async ({ page }) => {
  let fail = true, requests = 0;
  await page.route("**/api/v1/compare/comparisons/retry", route => { requests++; return fail ? route.abort() : route.continue(); });
  await page.goto("/compare/retry");
  await expect(page.getByRole("button", { name: "Retry", exact:true })).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "Retry", exact:true }).click();
  await expect(page.getByText("Comparison workbench")).toBeVisible();
  expect(requests).toBeGreaterThanOrEqual(2);
});

test("failed alignment save restores the displayed server values", async ({ page }) => {
  await page.route("**/api/v1/compare/comparisons/savefail", route => route.request().method() === "PATCH"
    ? route.fulfill({ status:503, json:{detail:"disk unavailable"} }) : route.continue());
  await page.goto("/compare/savefail");
  await page.getByRole("button", { name:/⚙ Align/ }).click();
  const slider = page.getByRole("slider", { name:/Horizontal translation/ });
  await slider.focus(); await page.keyboard.press("ArrowRight");
  await expect(slider).toHaveValue("1");
  await expect(page.getByText("Save failed. The server version has been restored. You can retry your changes.")).toBeVisible();
  await expect(slider).toHaveValue("0");
  const offset = page.getByRole("spinbutton", { name:/B action start/ });
  await offset.fill("600");
  await expect(offset).toHaveValue("600");
  await expect(offset).toHaveValue("500");
});

test("report export flushes pending edits and always regenerates cached reports", async ({ page }) => {
  const requests: string[] = [];
  await page.route("**/api/v1/compare/comparisons/export**", async route => {
    const method = route.request().method();
    if (method === "PATCH" || method === "POST") requests.push(method);
    await route.continue();
  });
  await page.goto("/compare/export");
  await page.getByRole("button", { name:/⚙ Align/ }).click();
  const slider = page.getByRole("slider", { name:/Horizontal translation/ });
  await slider.focus(); await page.keyboard.press("ArrowRight");
  await page.getByRole("button", { name:"Done", exact:true }).click();
  await page.getByRole("button", { name:"Export report", exact:true }).click();
  await expect(page.getByText('"tx":1', { exact:false })).toBeVisible();
  expect(requests).toEqual(["PATCH", "POST"]);
  await page.getByRole("button", { name:"Close", exact:true }).click();
  await page.getByRole("button", { name:"Export report", exact:true }).click();
  await expect.poll(() => requests.filter(method => method === "POST").length).toBe(2);
});

test("late save acknowledgements do not replace newer local edits", async ({ page }) => {
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  let writes = 0;
  await page.route("**/api/v1/compare/comparisons/ordering", async route => {
    if (route.request().method() !== "PATCH") return route.continue();
    writes++;
    if (writes === 1) await delayed;
    const patch = route.request().postDataJSON();
    await route.fulfill({ json:{...fixture.comparison,comparison_id:"ordering",...patch} });
  });
  await page.goto("/compare/ordering");
  await page.getByRole("button", { name:/⚙ Align/ }).click();
  const slider = page.getByRole("slider", { name:/Horizontal translation/ });
  await slider.focus(); await page.keyboard.press("ArrowRight");
  await expect.poll(() => writes).toBe(1);
  await page.keyboard.press("ArrowRight");
  await expect(slider).toHaveValue("2");
  release();
  await expect.poll(() => writes).toBe(2);
  await expect(slider).toHaveValue("2");
});


test("frame stepping before metadata waits for both videos and keeps the requested position", async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/v1/compare/comparisons/early/video/*", async route => { await pending; await route.continue(); });
  await page.goto("/compare/early", {waitUntil:"domcontentloaded"});
  await expect(page.getByText("Comparison workbench")).toBeVisible();
  await page.getByRole("button", { name:"+1", exact:true }).click();
  await page.getByRole("button", { name:"+1", exact:true }).click();
  await expect(page.getByTestId("comparison-clock")).toContainText("0.200s");
  release();
  await expect.poll(() => page.locator("video").first().evaluate((video: HTMLVideoElement) => Math.round(video.currentTime * 1000))).toBe(400);
  await expect.poll(() => page.locator("video").nth(1).evaluate((video: HTMLVideoElement) => Math.round(video.currentTime * 1000))).toBe(700);
  await expect(page.getByTestId("comparison-clock")).toContainText("0.200s");
});

test("a newer save retains an earlier edit when its first request fails", async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let writes = 0;
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/v1/compare/comparisons/failedorder", async route => {
    if (route.request().method() !== "PATCH") return route.continue();
    writes++; bodies.push(route.request().postDataJSON());
    if (writes === 1) { await pending; return route.fulfill({status:503,json:{detail:"temporary failure"}}); }
    await route.continue();
  });
  await page.goto("/compare/failedorder");
  await page.getByRole("button", { name:/⚙ Align/ }).click();
  const slider = page.getByRole("slider", { name:/Horizontal translation/ });
  await slider.focus(); await page.keyboard.press("ArrowRight");
  await expect.poll(() => writes).toBe(1);
  await page.getByRole("spinbutton", { name:/B action start/ }).fill("600");
  release();
  await expect.poll(() => writes).toBe(2);
  await expect(slider).toHaveValue("1");
  expect(bodies[1]).toMatchObject({spatial:{tx:1},temporal:{offset_ms_b:600}});
});
