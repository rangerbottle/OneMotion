import { test, expect } from "@playwright/test";
import fixture from "./fixtures/compare.json";

test("navigation flushes a pending save to its original comparison and ignores its late response", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  const writes: string[] = [];
  await page.route("**/api/v1/compare/comparisons/lifecycle*", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    writes.push(new URL(route.request().url()).pathname);
    if (route.request().url().endsWith("/lifecycleold")) await delayed;
    await route.continue();
  });
  await page.route("**/api/v1/compare/players/p1", (route) => route.fulfill({ json: {
    ...fixture.playerDetail,
    comparisons: [{ ...fixture.playerDetail.comparisons[0], comparison_id: "lifecyclenew" }],
  } }));
  await page.goto("/compare/lifecycleold");
  await page.getByRole("button", { name: /⚙ Align/ }).click();
  const slider = page.getByRole("slider", { name: /Horizontal translation/ });
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await expect(slider).toHaveValue("1");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("link", { name: "Compare", exact: true }).click();
  await expect(page).toHaveURL(/\/compare$/);
  await expect.poll(() => writes.length).toBe(1);
  await page.getByRole("button", { name: /测试学员/ }).click();
  await page.getByRole("link", { name: /baseline.mp4 vs today.mp4/ }).click();
  await expect(page).toHaveURL(/\/compare\/lifecyclenew$/);
  await page.getByRole("button", { name: /⚙ Align/ }).click();
  await expect(slider).toHaveValue("0");
  release();
  await expect.poll(async () => {
    const response = await page.request.get("http://127.0.0.1:8129/api/v1/compare/comparisons/lifecycleold");
    return (await response.json()).spatial.tx;
  }).toBe(1);
  await expect(slider).toHaveValue("0");
  // The prior slider was unmounted; opening the new dialog leaves its toolbar
  // button focused. Target the new input before changing its value.
  await slider.focus();
  await expect(slider).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(slider).toHaveValue("1");
  await expect.poll(() => writes.length).toBe(2);
  expect(writes).toEqual([
    "/api/v1/compare/comparisons/lifecycleold",
    "/api/v1/compare/comparisons/lifecyclenew",
  ]);
  expect(errors).toEqual([]);
});

test("returning to the same comparison waits for its previous controller write before loading and editing", async ({ page }) => {
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  const writes: number[] = [];
  let reads = 0;
  await page.route("**/api/v1/compare/comparisons/samecontroller", async (route) => {
    if (route.request().method() === "GET") {
      reads += 1;
      return route.continue();
    }
    const patch = route.request().postDataJSON();
    writes.push(patch.spatial.tx);
    if (writes.length === 1) await delayed;
    await route.continue();
  });
  await page.route("**/api/v1/compare/players/p1", (route) => route.fulfill({ json: {
    ...fixture.playerDetail,
    comparisons: [{ ...fixture.playerDetail.comparisons[0], comparison_id: "samecontroller" }],
  } }));
  await page.goto("/compare/samecontroller");
  await page.getByRole("button", { name: /⚙ Align/ }).click();
  const slider = page.getByRole("slider", { name: /Horizontal translation/ });
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await expect(slider).toHaveValue("1");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("link", { name: "Compare", exact: true }).click();
  await expect.poll(() => writes).toEqual([1]);
  await page.getByRole("button", { name: /测试学员/ }).click();
  await page.getByRole("link", { name: /baseline.mp4 vs today.mp4/ }).click();
  await expect(page).toHaveURL(/\/compare\/samecontroller$/);
  await expect(page.getByText("Loading comparison workbench…")).toBeVisible();
  expect(reads).toBe(1);
  release();
  await page.getByRole("button", { name: /⚙ Align/ }).click();
  await expect(slider).toHaveValue("1");
  expect(reads).toBe(2);
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await expect(slider).toHaveValue("2");
  await expect(page.getByText("Changes saved", { exact: true })).toBeVisible();
  expect(writes).toEqual([1, 2]);
  const response = await page.request.get("http://127.0.0.1:8129/api/v1/compare/comparisons/samecontroller");
  expect((await response.json()).spatial.tx).toBe(2);
  await page.reload();
  await page.getByRole("button", { name: /⚙ Align/ }).click();
  await expect(slider).toHaveValue("2");
});

test("failed save recovery retains an explicit retry draft after rolling back", async ({ page }) => {
  let fail = true;
  await page.route("**/api/v1/compare/comparisons/retrydraft", (route) => route.request().method() === "PATCH" && fail
    ? route.fulfill({ status: 503, json: { detail: "temporary failure" } }) : route.continue());
  await page.goto("/compare/retrydraft");
  await page.getByRole("button", { name: /⚙ Align/ }).click();
  const slider = page.getByRole("slider", { name: /Horizontal translation/ });
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await expect(slider).toHaveValue("1");
  await expect(page.getByText(/Save failed. The server version has been restored/)).toBeVisible();
  await expect(slider).toHaveValue("0");
  // The saved server state is visible; retry reapplies exactly the failed edit.
  await page.getByRole("button", { name: "Done", exact: true }).click();
  fail = false;
  await page.getByRole("button", { name: "Retry save", exact: true }).click();
  await expect(page.getByText("Changes saved", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /⚙ Align/ }).click();
  await expect(slider).toHaveValue("1");
  await page.reload();
  await page.getByRole("button", { name: /⚙ Align/ }).click();
  await expect(slider).toHaveValue("1");
});

test("a new opacity edit reapplies the failed alignment draft after server rollback", async ({ page }) => {
  const writes: Record<string, unknown>[] = [];
  await page.route("**/api/v1/compare/comparisons/mergedraft", async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    writes.push(route.request().postDataJSON());
    if (writes.length === 1) return route.fulfill({ status: 503, json: { detail: "temporary failure" } });
    await route.continue();
  });
  await page.goto("/compare/mergedraft");
  await page.getByRole("button", { name: /⚙ Align/ }).click();
  const slider = page.getByRole("slider", { name: /Horizontal translation/ });
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await expect(slider).toHaveValue("1");
  await expect(page.getByText(/Save failed. The server version has been restored/)).toBeVisible();
  await expect(slider).toHaveValue("0");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const opacity = page.getByRole("slider", { name: "Opacity", exact: true });
  await opacity.focus();
  await page.keyboard.press("ArrowRight");
  await expect(opacity).toHaveValue("51");
  await page.getByRole("button", { name: /⚙ Align/ }).click();
  await expect(slider).toHaveValue("1");
  await expect(page.getByText("Changes saved", { exact: true })).toBeVisible();
  expect(writes).toHaveLength(2);
  expect(writes[1]).toMatchObject({ spatial: { tx: 1 }, opacity_default: 0.51 });
  const response = await page.request.get("http://127.0.0.1:8129/api/v1/compare/comparisons/mergedraft");
  expect(await response.json()).toMatchObject({ spatial: { tx: 1 }, opacity_default: 0.51 });
});

test("when both save and recovery are offline the draft stays visible and can be retried", async ({ page }) => {
  let offline = false;
  await page.route("**/api/v1/compare/comparisons/offlinedraft", (route) => offline ? route.abort() : route.continue());
  await page.goto("/compare/offlinedraft");
  await page.getByRole("button", { name: /⚙ Align/ }).click();
  const slider = page.getByRole("slider", { name: /Horizontal translation/ });
  offline = true;
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByText("Save failed. Your changes are still unsaved. Check your connection and try again.")).toBeVisible();
  await expect(slider).toHaveValue("1");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  offline = false;
  await page.getByRole("button", { name: "Retry save", exact: true }).click();
  await expect(page.getByText("Changes saved", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /⚙ Align/ }).click();
  await expect(slider).toHaveValue("1");
});

test("edits made during report generation remain optimistic and save after the report request", async ({ page }) => {
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  const requests: string[] = [];
  await page.route("**/api/v1/compare/comparisons/reportediting**", async (route) => {
    const method = route.request().method();
    if (method === "PATCH" || method === "POST") requests.push(method);
    if (method === "POST" && requests.length === 1) await delayed;
    await route.continue();
  });
  await page.goto("/compare/reportediting");
  await page.getByRole("button", { name: "Export report", exact: true }).click();
  await expect.poll(() => requests).toEqual(["POST"]);
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("button", { name: /⚙ Align/ }).click();
  const slider = page.getByRole("slider", { name: /Horizontal translation/ });
  await slider.focus();
  await page.keyboard.press("ArrowRight");
  await expect(slider).toHaveValue("1");
  await expect(page.getByText("Saving…", { exact: true })).toBeVisible();
  expect(requests).toEqual(["POST"]);
  release();
  await expect.poll(() => requests).toEqual(["POST", "PATCH"]);
  await expect(page.getByText("Changes saved", { exact: true })).toBeVisible();
  await expect(slider).toHaveValue("1");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Export report", exact: true }).click();
  await expect(page.getByText('"tx":1', { exact: false })).toBeVisible();
  expect(requests).toEqual(["POST", "PATCH", "POST"]);
});
