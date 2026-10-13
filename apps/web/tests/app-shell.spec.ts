import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import compareFixture from "./fixtures/compare.json";

const navigation = [
  ["Dashboard", "/"], ["Training", "/drills"], ["Progress", "/progress"],
  ["Analyze", "/analyze"], ["Compare", "/compare"],
] as const;
const routes = [
  { url: "/", active: "Dashboard" },
  { url: "/drills", active: "Training" },
  { url: "/training?drill=close-form", active: "Training" },
  { url: "/progress", active: "Progress" },
  { url: "/analyze", active: "Analyze" },
  { url: "/record", active: "Analyze" },
  { url: "/upload", active: "Analyze" },
  { url: "/homecourt", active: "Analyze" },
  { url: "/analysis/demo", active: "Analyze" },
  { url: "/references", active: "Analyze" },
  { url: "/references?view=front", active: "Analyze" },
  { url: "/references?view=side", active: "Analyze" },
] as const;
const sourceTabs = [["Record", "/record"], ["Upload", "/upload"], ["HomeCourt import", "/homecourt"]] as const;

test.beforeEach(async ({ context }) => {
  // The shell tests must not inherit training rows created by another test file.
  await context.route(/\/api\/v1\/training\/sessions(?:\?.*)?$/, async route => {
    if (route.request().method() !== "GET") { await route.continue(); return; }
    await route.fulfill({ headers: { "Access-Control-Allow-Origin": "*" }, json: {
      sessions: [], has_more: false,
      summary: { sessions: 0, completed_sessions: 0, attempts: 0, makes: 0, accuracy_pct: null, duration_ms: 0 },
    } });
  });
});

async function assertNavigation(page: Page, active: string) {
  const nav = page.getByRole("navigation", { name: "Main navigation", exact: true });
  await expect(nav.getByRole("link")).toHaveText(navigation.map(([label]) => label));
  for (const [label, href] of navigation) {
    const link = nav.getByRole("link", { name: label, exact: true });
    await expect(link).toHaveAttribute("href", href);
    if (label === active) await expect(link).toHaveAttribute("aria-current", "page");
    else await expect(link).not.toHaveAttribute("aria-current", "page");
  }
  await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
}

async function assertEnglishUI(page: Page) {
  const main = page.getByRole("main");
  await expect(main).not.toContainText(/[\p{Script=Han}]/u);
  const accessibleCopy = await main.locator("[aria-label], [placeholder], [title]").evaluateAll(elements =>
    elements.flatMap(element => ["aria-label", "placeholder", "title"].map(name => element.getAttribute(name) ?? "")).join("\n"));
  expect(accessibleCopy).not.toMatch(/[\p{Script=Han}]/u);
}

async function assertPaintAndFont(page: Page) {
  await page.evaluate(async () => { await document.fonts.ready; });
  const paint = await page.evaluate(() => {
    const primaryFont = (family: string) => family.split(",")[0].trim().replace(/["']/g, "");
    const body = getComputedStyle(document.body);
    const resolveColor = (variable: string) => {
      const probe = document.createElement("span");
      probe.style.backgroundColor = `var(${variable})`;
      document.body.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    };
    const font = primaryFont(body.fontFamily);
    const elements = [...document.querySelectorAll("main h1, main h2, main h3, main button, main input, main select, main .tabular-nums")]
      .filter(element => element.getBoundingClientRect().height > 0 && getComputedStyle(element).visibility !== "hidden");
    const fonts = elements.map(element => ({
      label: `${element.tagName}: ${(element.textContent || element.getAttribute("aria-label") || "input").trim().slice(0, 40)}`,
      family: primaryFont(getComputedStyle(element).fontFamily),
    }));
    const surfaces = [...document.querySelectorAll("main .surface")].map(element => getComputedStyle(element).backgroundColor);
    return {
      background: body.backgroundColor, expectedBackground: resolveColor("--background"),
      htmlBackground: getComputedStyle(document.documentElement).backgroundColor,
      surface: resolveColor("--surface"), surfaces, font, fonts,
      loadedFonts: [...document.fonts].filter(face => primaryFont(face.family) === font).map(face => face.status),
      width: document.documentElement.scrollWidth, viewportWidth: window.innerWidth,
    };
  });
  expect(paint.background).toBe(paint.expectedBackground);
  expect(paint.htmlBackground).toBe(paint.background);
  expect(paint.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(paint.font).toMatch(/geist/i);
  expect(paint.loadedFonts).toContain("loaded");
  expect(paint.fonts.length).toBeGreaterThan(0);
  expect(paint.fonts.filter(item => item.family !== paint.font)).toEqual([]);
  expect(paint.surfaces.filter(color => color !== paint.surface)).toEqual([]);
  expect(paint.width).toBeLessThanOrEqual(paint.viewportWidth);
  return { background: paint.background, surface: paint.surface, font: paint.font };
}

test("one canonical navigation groups training and all analysis sources and reports", async ({ page }) => {
  for (const route of routes) await test.step(route.url, async () => {
    await page.goto(route.url);
    await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible();
    await assertNavigation(page, route.active);
    if (route.url === "/progress") await expect(page.getByRole("heading", { name: "No training history yet", exact: true })).toBeVisible();
    if (route.url.startsWith("/training")) await expect(page.getByRole("button", { name: "Start recording", exact: true })).toBeEnabled();
    await assertEnglishUI(page);
    if (sourceTabs.some(([, href]) => href === route.url)) {
      const tabs = page.getByRole("navigation", { name: "Analysis source", exact: true });
      for (const [label, href] of sourceTabs) await expect(tabs.getByRole("link", { name: label, exact: true })).toHaveAttribute("href", href);
      await expect(tabs.locator('[aria-current="page"]')).toHaveAttribute("href", route.url);
    }
  });
  await page.goto("/analyze");
  const main = page.getByRole("main");
  for (const href of ["/record", "/upload", "/homecourt", "/compare/new"]) await expect(main.locator(`a[href="${href}"]`)).toBeVisible();
  await main.locator('a[href="/record"]').click();
  await expect(page).toHaveURL(/\/record$/);
  await assertNavigation(page, "Analyze");
  await page.goto("/compare/demo");
  await expect(page.getByTestId("comparison-clock")).toBeVisible();
  await assertNavigation(page, "Compare");
});

for (const colorScheme of ["light", "dark"] as const) test(`375px ${colorScheme} pages share semantic paint and one loaded sans family`, async ({ page }) => {
  test.setTimeout(45_000);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ colorScheme });
  let baseline: Awaited<ReturnType<typeof assertPaintAndFont>> | undefined;
  for (const route of [...routes, { url: "/compare/demo", active: "Compare" }]) await test.step(route.url, async () => {
    await page.goto(route.url);
    if (route.url.startsWith("/compare")) await expect(page.getByTestId("comparison-clock")).toBeVisible();
    else await expect(page.getByRole("main").getByRole("heading", { level: 1 })).toBeVisible();
    if (route.url === "/progress") await expect(page.getByRole("region", { name: "All saved training statistics", exact: true })).toBeVisible();
    const paint = await assertPaintAndFont(page);
    baseline ??= paint;
    expect(paint).toEqual(baseline);
  });
  expect(baseline!.background).not.toBe(colorScheme === "light" ? "rgb(21, 25, 21)" : "rgb(247, 247, 242)");
});

test("English controls preserve original filenames, camera labels and saved comparison names", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/homecourt");
  await assertEnglishUI(page);
  const filename = "投篮训练-original.webm";
  const camera = "右侧固定机位 · Court A";
  await page.locator('input[type="file"]').setInputFiles({
    name: filename, mimeType: "video/webm", buffer: readFileSync(resolve(process.cwd(), "tests/fixtures/homecourt-session.webm")),
  });
  await expect(page.getByRole("spinbutton", { name: "End time (seconds)", exact: true })).toBeVisible();
  await page.getByLabel("Camera label (optional)", { exact: true }).fill(camera);
  await expect(page.getByLabel("Camera label (optional)", { exact: true })).toHaveValue(camera);
  await assertPaintAndFont(page); // Includes the selected interval's numeric inputs.
  await page.getByRole("checkbox", { name: /I confirm I am the only person/ }).check();
  await page.getByRole("button", { name: "Analyze selected shot", exact: true }).click();
  await expect(page).toHaveURL(/\/analysis\/homecourt\d+$/);
  await assertNavigation(page, "Analyze");
  const source = page.getByRole("region", { name: "Practice source", exact: true });
  await expect(source.getByText(filename, { exact: true })).toBeVisible();
  await expect(source.getByText(`Camera: ${camera}`, { exact: true })).toBeVisible();
  await expect(source).toContainText("Playback speed unknown");
  await expect(source).toContainText("Timing and velocity conclusions are disabled");
  await page.goto("/analysis/source");
  await page.getByRole("button", { name: "View full Curry source video", exact: true }).click();
  await expect(page.getByText(/The reference uses the first 3 seconds of this complete source/)).toBeVisible();
  await assertEnglishUI(page);
  await page.goto("/compare");
  await page.getByRole("button", { name: new RegExp(compareFixture.player.name) }).click();
  await expect(page.getByText(compareFixture.player.name, { exact: true })).toBeVisible();
  await expect(page.getByText(compareFixture.playerDetail.templates[0].name, { exact: true })).toBeVisible();
  for (const phase of compareFixture.playerDetail.templates[0].default_phases) await expect(page.getByText(phase, { exact: true })).toBeVisible();
  await assertNavigation(page, "Compare");
});
