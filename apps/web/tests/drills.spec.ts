import { test, expect } from "@playwright/test";
import { drills, getDrill, recommendDrills, workoutPlans } from "../lib/drills";
import report from "./fixtures/report.json";
import type { AnalysisResult } from "../lib/api";

test("drill library searches, combines category filters and restores an empty result", async ({ page }) => {
  await page.goto("/drills");
  await expect(page.getByRole("heading", { name: "Shooting drills", exact: true })).toBeVisible();
  const list = page.getByRole("region", { name: "Drill list" });
  await expect(list.getByRole("article")).toHaveCount(drills.length);
  await page.getByRole("searchbox", { name: "Search drills" }).fill("Quiet guide hand");
  await expect(list.getByRole("article")).toHaveCount(1);
  await expect(list.getByRole("link", { name: "Quiet guide hand", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Game situations", exact: true }).click();
  await expect(page.getByRole("button", { name: "Game situations", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(list.getByRole("article")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "No matching drills" })).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.getByRole("searchbox", { name: "Search drills" })).toHaveValue("");
  await expect(list.getByRole("article")).toHaveCount(drills.length);
  await page.getByRole("button", { name: "Footwork", exact: true }).click();
  await expect(list.getByRole("article")).toHaveCount(drills.filter((drill) => drill.category === "footwork").length);
  await expect(list.getByRole("link", { name: "Star rotation", exact: true })).toBeVisible();
  await expect(list.getByRole("link", { name: "Close-range form", exact: true })).toHaveCount(0);
});

test("drill details show the workload, instructions, court and selected training handoff on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/drills");
  await page.getByRole("region", { name: "Drill list" }).getByRole("link", { name: "Close-range form", exact: true }).click();
  await expect(page).toHaveURL(/\/drills\/close-form$/);
  await expect(page.getByRole("heading", { name: "Close-range form", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "How to practice" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Keep in mind" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Record a shot for review" })).toBeVisible();
  await expect(page.getByText("4 sets", { exact: true })).toBeVisible();
  await expect(page.getByText("6 attempts", { exact: true })).toBeVisible();
  await expect(page.getByText("30 seconds", { exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: /Close-range form, schematic spots/ })).toBeVisible();
  const start = page.getByRole("link", { name: "Start this drill" });
  await expect(start).toHaveAttribute("href", "/training?drill=close-form");
  expect((await start.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("link", { name: "Back to drills" }).click();
  await expect(page).toHaveURL(/\/drills$/);
});

test("unknown drill returns a real not-found response and never offers an invented workout", async ({ page }) => {
  const response = await page.goto("/drills/not-a-real-drill");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "404", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Start this drill" })).toHaveCount(0);
});

test("plans contain real drills and recommendations exclude unreliable or missing measurements", () => {
  for (const plan of workoutPlans) expect(plan.drillIds.every((id) => getDrill(id) !== undefined)).toBe(true);
  const result = report as AnalysisResult;
  const feedback = [
    { ...result.feedback[0], rank: 1, metric: "shot_tempo_s" },
    { ...result.feedback[0], rank: 2, metric: "follow_through_hold_s" },
    { ...result.feedback[0], rank: 3, metric: "knee_flexion_deg" },
  ];
  const metrics = [
    { ...result.metrics[0], name: "shot_tempo_s", value: 0.8, reliable: false },
    { ...result.metrics[0], name: "follow_through_hold_s", value: 0.3, reliable: true },
    { ...result.metrics[0], name: "knee_flexion_deg", value: null, reliable: true },
  ];
  expect(recommendDrills({ metrics, feedback }).map((drill) => drill.id)).toEqual(["follow-through"]);
  expect(recommendDrills({ metrics, feedback: [] })).toEqual([]);
  expect(recommendDrills({ metrics, feedback }, 0)).toEqual([]);
});

test("a workout can start from its library card with the original ordered plan", async ({ page }) => {
  await page.goto("/drills");
  const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Find your shooting rhythm", exact: true }) });
  await card.getByRole("link", { name: "Start workout plan →", exact: true }).click();
  await expect(page).toHaveURL(/\/training\?plan=smooth-foundation$/);
  await expect(page.getByRole("heading", { name: "Close-range form", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Start recording", exact: true })).toBeEnabled();
});
