import { test, expect, type Page } from "@playwright/test";
import fixture from "./fixtures/compare.json";

async function pickExistingPair(page: Page) {
  await page.goto("/compare/new?player=p1&template=t1");
  await page.getByRole("combobox", { name: "Existing clip" }).selectOption("c1");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("combobox", { name: "Existing clip" }).selectOption("c2");
  await page.getByRole("button", { name: "Next", exact: true }).click();
}

test("comparison creation locks backward navigation and picking another clip creates the current pair", async ({ page }) => {
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  const pairs: { baseline_clip_id: string; comparison_clip_id: string }[] = [];
  await page.route("**/api/v1/compare/players/p1", (route) => route.fulfill({ json: {
    ...fixture.playerDetail, clips: [...fixture.playerDetail.clips, { ...fixture.playerDetail.clips[1], clip_id: "c3", filename: "new-shot.mp4" }],
  } }));
  await page.route("**/api/v1/compare/comparisons", async (route) => {
    const input = route.request().postDataJSON();
    pairs.push(input);
    if (pairs.length === 1) await delayed;
    await route.fulfill({ json: { ...fixture.comparison, ...input, comparison_id: `wizard${pairs.length}` } });
  });
  await pickExistingPair(page);
  await expect.poll(() => pairs.length).toBe(1);
  await expect(page.getByRole("button", { name: "Back", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Create and open workbench" })).toBeDisabled();
  release();
  await expect(page.getByText(/✅ Camera matched/)).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("combobox", { name: "Existing clip" }).selectOption("c3");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect.poll(() => pairs.length).toBe(2);
  expect(pairs).toMatchObject([{ baseline_clip_id: "c1", comparison_clip_id: "c2" }, { baseline_clip_id: "c1", comparison_clip_id: "c3" }]);
});

test("a late player detail response cannot replace the newly selected player's templates", async ({ page }) => {
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  let firstRequested = false;
  const second = { ...fixture.player, player_id: "p2", name: "第二位学员" };
  await page.route("**/api/v1/compare/players", (route) => route.fulfill({ json: [fixture.player, second] }));
  await page.route("**/api/v1/compare/players/p1", async (route) => { firstRequested = true; await delayed; await route.fulfill({ json: fixture.playerDetail }); });
  await page.route("**/api/v1/compare/players/p2", (route) => route.fulfill({ json: {
    ...fixture.playerDetail, player: second, templates: [{ ...fixture.playerDetail.templates[0], player_id: "p2", template_id: "t2", name: "第二位的跳投" }], clips: [],
  } }));
  await page.goto("/compare/new");
  await page.getByRole("combobox", { name: "Player", exact: true }).selectOption("p1");
  await expect.poll(() => firstRequested).toBe(true);
  await page.getByRole("combobox", { name: "Player", exact: true }).selectOption("p2");
  await expect(page.getByRole("combobox", { name: "Action template" })).toHaveValue("t2");
  release();
  await expect(page.getByRole("combobox", { name: "Action template" })).toHaveValue("t2");
  await expect(page.getByRole("option", { name: "第二位的跳投" })).toHaveCount(1);
  await expect(page.getByRole("option", { name: "跳投", exact: true })).toHaveCount(0);
});

test("changing the action template clears both previously selected clips", async ({ page }) => {
  await page.route("**/api/v1/compare/players", (route) => route.fulfill({ json: [fixture.player] }));
  await page.route("**/api/v1/compare/players/p1", (route) => route.fulfill({ json: {
    ...fixture.playerDetail, templates: [...fixture.playerDetail.templates, { ...fixture.playerDetail.templates[0], template_id: "t2", name: "另一动作" }],
    clips: [...fixture.playerDetail.clips, ...fixture.playerDetail.clips.map((clip) => ({ ...clip, clip_id: `${clip.clip_id}new`, template_id: "t2" }))],
  } }));
  await page.goto("/compare/new");
  await page.getByRole("combobox", { name: "Player", exact: true }).selectOption("p1");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("combobox", { name: "Existing clip" }).selectOption("c1");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("combobox", { name: "Existing clip" }).selectOption("c2");
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("combobox", { name: "Action template" }).selectOption("t2");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "Existing clip" })).toHaveValue("");
  await page.getByRole("combobox", { name: "Existing clip" }).selectOption("c1new");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "Existing clip" })).toHaveValue("");
});

test("failed offset save stays in the wizard and retries only the bounded integer offsets", async ({ page }) => {
  let state = { ...fixture.comparison, comparison_id: "wizardoffset" };
  const writes: { temporal: { offset_ms_a: number; offset_ms_b: number } }[] = [];
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/v1/compare/comparisons", (route) => route.fulfill({ json: state }));
  await page.route("**/api/v1/compare/comparisons/wizardoffset", async (route) => {
    if (route.request().method() !== "PATCH") return route.fulfill({ json: state });
    const patch = route.request().postDataJSON();
    writes.push(patch);
    if (writes.length === 1) return route.fulfill({ status: 422, json: { detail: "Could not save action starts. Try again." } });
    await delayed;
    state = { ...state, temporal: { ...state.temporal, ...patch.temporal } };
    await route.fulfill({ json: state });
  });
  await pickExistingPair(page);
  const offsetA = page.getByRole("spinbutton", { name: "Baseline start (ms)" });
  const offsetB = page.getByRole("spinbutton", { name: "Comparison start (ms)" });
  await offsetA.fill("-10");
  await expect(offsetA).toHaveValue("0");
  await offsetA.fill("99999");
  await expect(offsetA).toHaveValue("1999");
  await offsetA.fill("550.6");
  await expect(offsetA).toHaveValue("551");
  await offsetB.fill("601");
  await page.getByRole("button", { name: "Create and open workbench" }).click();
  await expect(page.getByRole("status")).toContainText("Could not save action starts. Try again.");
  await expect(page).toHaveURL(/\/compare\/new\?/);
  await page.getByRole("button", { name: "Create and open workbench" }).click();
  await expect.poll(() => writes.length).toBe(2);
  await expect(page.getByRole("button", { name: "Saving action starts…" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Back", exact: true })).toBeDisabled();
  await expect(offsetA).toBeDisabled();
  expect(writes).toEqual([{ temporal: { offset_ms_a: 551, offset_ms_b: 601 } }, { temporal: { offset_ms_a: 551, offset_ms_b: 601 } }]);
  release();
  await expect(page).toHaveURL(/\/compare\/wizardoffset$/);
});
