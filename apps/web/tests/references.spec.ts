import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "@playwright/test";
import { curryReferences, referenceSourceUrl } from "../lib/curry-references";

test("display metadata preserves researched identity, timing uncertainty and review evidence", () => {
  const catalog = JSON.parse(readFileSync(resolve(process.cwd(), "../../docs/research/curry-reference-candidates.json"), "utf-8"));
  expect(curryReferences).toHaveLength(catalog.candidates.length);
  expect(new Set(curryReferences.map(item => item.id)).size).toBe(curryReferences.length);
  for (const item of curryReferences) {
    const evidence = catalog.candidates.find((source: { id: string }) => source.id === item.id);
    expect(evidence, item.id).toBeDefined();
    expect(new URL(referenceSourceUrl(item)).href).toBe(new URL(evidence.url).href);
    expect(item.platform).toBe(evidence.platform);
    expect(item.speed).toBe(evidence.timing.mode);
    expect(item.reviewed).toBe(evidence.review_status === "spot_checked");
    if (!item.reviewed) expect(item.views).toEqual(["unreviewed"]);
    expect(item.views).not.toContain("side"); // No new complete pure-side shot has passed review.
    for (const bookmark of item.bookmarks) {
      expect(evidence.inspection_points.some((point: { at_ms: number }) => Math.abs(point.at_ms - bookmark.seconds * 1000) < 1000)).toBe(true);
    }
  }
  expect(catalog.policy.allowed_scoring_metrics).toEqual([]);
  expect(catalog.policy.activate_candidates).toBe(false);
});

test("the shared entry opens a useful library without contacting a video host", async ({ page, context }) => {
  const external: string[] = [];
  context.on("request", request => { if (/youtube|bilibili/.test(new URL(request.url()).hostname)) external.push(request.url()); });
  await page.goto("/analyze");
  await page.getByRole("region", { name: "Curry reference library", exact: true }).getByRole("link", { name: "Browse all references" }).click();
  await expect(page).toHaveURL(/\/references$/);
  await expect(page.getByRole("status").first()).toHaveText("8 sources · All views");
  await expect(page.getByRole("region", { name: "Reference sources", exact: true }).getByRole("link")).toHaveCount(8);
  await expect(page.getByRole("navigation", { name: "Main navigation", exact: true }).getByRole("link", { name: "Analyze", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("region", { name: "Selected reference", exact: true })).toContainText("Visual study only");
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(external).toEqual([]);
});

test("view and platform filters compose, expose missing footage, and reset", async ({ page }) => {
  await page.goto("/references?view=front");
  const views = page.getByRole("navigation", { name: "Filter by camera view", exact: true });
  const platforms = page.getByRole("navigation", { name: "Filter by platform", exact: true });
  await expect(page.getByRole("region", { name: "Selected reference", exact: true })).toContainText("Slow-motion scale is unknown");
  await expect(page.getByRole("status").first()).toHaveText("1 source · Front");
  await platforms.getByRole("link", { name: "YouTube", exact: true }).click();
  await expect(page).toHaveURL(/view=front&platform=youtube/);
  await expect(page.getByRole("region", { name: "No matching references", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Show all references", exact: true }).click();
  // Wait for the reset navigation to commit before clicking the next filter —
  // otherwise the click can land on the stale page whose links still carry
  // platform=youtube (RSC navigation is async).
  await expect(page).toHaveURL(/\/references$/);
  await views.getByRole("link", { name: /^Side / }).click();
  await expect(page.getByRole("heading", { name: "No reviewed side-view shots yet", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Current scored reference", exact: true })).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
  await views.getByRole("link", { name: /^View unreviewed / }).click();
  await expect(page.getByRole("status").first()).toHaveText("2 sources · View unreviewed");
  await expect(page.getByRole("region", { name: "Selected reference", exact: true })).toContainText("Only the source details have been reviewed");
  await expect(page.getByRole("heading", { name: "Review bookmarks", exact: true })).toHaveCount(0);
});

test("embedded playback is opt-in, bookmarks seek, and switching source unloads the old player", async ({ page, context }) => {
  const external: string[] = [];
  const mutations: string[] = [];
  context.on("request", request => {
    if (request.url().includes("youtube-nocookie.com")) external.push(request.url());
    if (/POST|PUT|PATCH|DELETE/.test(request.method()) && request.url().includes("/api/")) mutations.push(request.url());
  });
  await context.route("https://www.youtube-nocookie.com/**", route => route.fulfill({ contentType: "text/html", body: "<html lang='en'><body>Test player</body></html>" }));
  await page.goto("/references");
  const selected = page.getByRole("region", { name: "Selected reference", exact: true });
  await selected.getByRole("button", { name: "4:51 · Lateral shooting chapter", exact: true }).click();
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(external).toEqual([]);
  await selected.getByRole("button", { name: "Load YouTube player", exact: false }).click();
  await expect(page.locator("iframe")).toHaveAttribute("src", /embed\/6mnujT_fzlY\?autoplay=0&start=291&playsinline=1$/);
  await expect.poll(() => external.length).toBe(1);
  await selected.getByRole("button", { name: "1:43 · Shooting foundation chapter", exact: true }).click();
  await expect(page.locator("iframe")).toHaveCount(1);
  await expect(page.locator("iframe")).toHaveAttribute("src", /start=103/);
  await selected.getByRole("button", { name: "Unload player", exact: true }).click();
  await expect(page.locator("iframe")).toHaveCount(0);
  await selected.getByRole("button", { name: "Load YouTube player", exact: false }).click();
  await page.getByRole("link", { name: "View 105 threes in a row", exact: true }).click();
  await expect(selected.getByRole("heading", { name: "105 threes in a row", exact: true })).toBeVisible();
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(selected.getByRole("link", { name: "Open source on YouTube", exact: false })).toHaveAttribute("href", "https://www.youtube.com/watch?v=VDAExNXyP_Q");
  expect(mutations).toEqual([]);
});

test("Bilibili playback retains slow-motion limits and always offers the source upload", async ({ page, context }) => {
  await context.route("https://player.bilibili.com/**", route => route.fulfill({ contentType: "text/html", body: "<html lang='en'><body>External player unavailable</body></html>" }));
  await page.goto("/references?view=front");
  const selected = page.getByRole("region", { name: "Selected reference", exact: true });
  await selected.getByRole("button", { name: "0:19 · Front upper-body detail", exact: true }).click();
  await selected.getByRole("button", { name: "Load Bilibili player", exact: false }).click();
  await expect(page.locator("iframe")).toHaveAttribute("src", "https://player.bilibili.com/player.html?bvid=BV1iu41167Jd&autoplay=0&t=19");
  await expect(selected).toContainText("Timing and velocity comparisons are unavailable");
  await expect(selected.getByRole("link", { name: "Open source on Bilibili", exact: false })).toHaveAttribute("href", "https://www.bilibili.com/video/BV1iu41167Jd/?t=19");
  await expect(selected.getByRole("link", { name: "Open source on Bilibili", exact: false })).toHaveAttribute("rel", "noopener noreferrer");
});

test("analysis-to-library navigation retains report context through filters and selections", async ({ page }) => {
  await page.goto("/analysis/demo");
  await page.getByRole("region", { name: "Curry reference library", exact: true }).getByRole("link", { name: "Rear view", exact: false }).click();
  await expect(page).toHaveURL(/\/references\?view=rear&analysis=demo$/);
  await page.getByRole("link", { name: "View Close rear-view shooting", exact: true }).click();
  await expect(page.getByRole("region", { name: "Selected reference", exact: true })).toContainText("A foreground coach obstructs");
  await page.reload();
  await expect(page.getByRole("region", { name: "Selected reference", exact: true }).getByRole("heading", { name: "Close rear-view shooting", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Back to your analysis", exact: false }).click();
  await expect(page).toHaveURL(/\/analysis\/demo$/);
  await expect(page.getByText("Synthetic test reference", { exact: true })).toBeVisible();
});

test("invalid queries fall back safely and the existing local full source remains playable", async ({ page }) => {
  await page.goto("/references?view=invalid&platform=invalid&reference=invalid&analysis=https%3A%2F%2Fexample.com");
  await expect(page.getByRole("status").first()).toHaveText("8 sources · All views");
  await expect(page.getByRole("link", { name: "Back to Analyze", exact: false })).toHaveAttribute("href", "/analyze");
  await expect(page.getByRole("link", { name: "Back to your analysis", exact: false })).toHaveCount(0);
  await page.getByRole("region", { name: "Current scored reference", exact: true }).locator("summary").click();
  await page.getByRole("button", { name: "View full Curry source video", exact: true }).click();
  const source = page.locator('video[src$="/source-video"]');
  await expect(source).toHaveAttribute("src", "http://127.0.0.1:8129/api/v1/templates/curry_v3/source-video");
  await expect.poll(() => source.evaluate(video => (video as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(2);
  await expect(page.getByRole("region", { name: "Current scored reference", exact: true })).toContainText("Your report shows whether timing comparison is available");
  await page.getByRole("button", { name: "Hide full Curry source video", exact: true }).click();
  await expect(source).toHaveCount(0);
});
