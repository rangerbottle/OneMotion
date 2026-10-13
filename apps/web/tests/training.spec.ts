import { test as base, expect, type Page } from "@playwright/test";
import type { TrainingHistory, TrainingInput, TrainingSession } from "../lib/training-api";
import { parseDraft, trainingInput, type TrainingDraft } from "../lib/training-draft";

const draftKey = "onemotion.training.draft.v1";
type Ledger = {
  posts: TrainingInput[];
  records: TrainingSession[];
  serverStatuses: number[];
  failAfterCommit: boolean;
  failReads: boolean;
  holdResponse?: Promise<void>;
};

function history(records: TrainingSession[]): TrainingHistory {
  const attempts = records.reduce((sum, item) => sum + item.totals.attempts, 0);
  const makes = records.reduce((sum, item) => sum + item.totals.makes, 0);
  return { sessions: [...records].reverse(), has_more: false, summary: {
    sessions: records.length, completed_sessions: records.filter(item => item.status === "completed").length,
    attempts, makes, accuracy_pct: attempts ? 100 * makes / attempts : null,
    duration_ms: records.reduce((sum, item) => sum + item.totals.duration_ms, 0),
  } };
}

// Each test reads only its own records; POST still exercises the UUID-aware stub.
const test = base.extend<{ ledger: Ledger }>({
  ledger: async ({ context }, runFixture) => {
    const ledger: Ledger = { posts: [], records: [], serverStatuses: [], failAfterCommit: false, failReads: false };
    await context.route(/\/api\/v1\/training\/sessions(?:\?.*)?$/, async route => {
      if (route.request().method() === "GET") {
        await route.fulfill(ledger.failReads
          ? { status: 503, headers: { "Access-Control-Allow-Origin": "*" }, json: { detail: "training storage is unavailable" } }
          : { headers: { "Access-Control-Allow-Origin": "*" }, json: history(ledger.records) });
        return;
      }
      if (route.request().method() !== "POST") { await route.continue(); return; }
      ledger.posts.push(route.request().postDataJSON() as TrainingInput);
      const response = await route.fetch();
      ledger.serverStatuses.push(response.status());
      const record = await response.json() as TrainingSession;
      if (response.ok() && !ledger.records.some(item => item.session_id === record.session_id)) ledger.records.push(record);
      if (ledger.holdResponse) await ledger.holdResponse;
      if (ledger.failAfterCommit) {
        ledger.failAfterCommit = false;
        await route.fulfill({ status: 503, headers: { "Access-Control-Allow-Origin": "*" }, json: { detail: "response delivery interrupted after commit" } });
      } else await route.fulfill({ response });
    });
    await runFixture(ledger);
  },
});

async function start(page: Page, query = "drill=close-form") {
  await page.goto(`/training?${query}`);
  await page.getByRole("button", { name: "Start recording", exact: true }).click();
}

async function completeCloseForm(page: Page, firstSetRecorded = 0, made = false) {
  for (let group = 0; group < 4; group++) {
    for (let attempt = group === 0 ? firstSetRecorded : 0; attempt < 6; attempt++) {
      await page.getByRole("button", { name: made ? "Made" : "Missed", exact: true }).click();
    }
    if (group < 3) await page.getByRole("button", { name: "Skip rest", exact: true }).click();
  }
}

test("reload restores recorded attempts, undo corrects the last shot, and a completed session enters history", async ({ page, ledger }) => {
  await start(page);
  await expect(page.getByRole("button", { name: "Finish and save" })).toBeDisabled();
  await page.getByRole("button", { name: "Made", exact: true }).click();
  await page.getByRole("button", { name: "Missed", exact: true }).click();
  await expect(page.getByText("Session 1 / 2 made", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("status")).toContainText("Your unsaved session has been restored");
  await expect(page.getByText("Session 1 / 2 made", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /Undo last shot/ }).click();
  await expect(page.getByText("Session 1 / 1 made", { exact: true })).toBeVisible();
  await completeCloseForm(page, 1);
  await expect(page.getByRole("button", { name: "Made", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Save session", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Session complete." })).toBeVisible();
  expect(ledger.posts).toHaveLength(1);
  expect(ledger.records[0]).toMatchObject({ status: "completed", planned_sets: 4, planned_reps: 6, totals: { attempts: 24, makes: 1, completed_sets: 4 } });
  expect(ledger.posts[0].sets.map(group => group.attempts.length)).toEqual([6, 6, 6, 6]);
  expect(ledger.posts[0].sets[0].attempts).toEqual([true, false, false, false, false, false]);
  expect(await page.evaluate(key => localStorage.getItem(key), draftKey)).toBeNull();
  await page.getByRole("link", { name: "View training history →", exact: true }).click();
  await expect(page.getByRole("region", { name: "All saved training statistics" })).toContainText("24");
  await expect(page.getByRole("heading", { name: "Close-range form", exact: true })).toBeVisible();
  await expect(page.getByText("1 / 24 made", { exact: true })).toBeVisible();
});

test("a lost save response freezes the request across reload and retries the same UUID without duplicating history", async ({ page, ledger }) => {
  ledger.failAfterCommit = true;
  await start(page);
  await page.getByRole("button", { name: "Made", exact: true }).click();
  await page.getByRole("button", { name: "Missed", exact: true }).click();
  await page.getByRole("button", { name: "Finish and save", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Save failed");
  await expect(page.getByRole("button", { name: "Made", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: /Undo last shot/ })).toBeDisabled();
  expect(await page.evaluate(key => localStorage.getItem(key), draftKey)).not.toBeNull();
  expect(ledger.records).toHaveLength(1); // The first request really committed server-side.
  const first = structuredClone(ledger.posts[0]);
  await page.reload();
  await expect(page.getByRole("button", { name: "Retry save", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Retry save", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Session saved. Keep your own pace." })).toBeVisible();
  expect(ledger.posts).toEqual([first, first]);
  expect(ledger.serverStatuses).toEqual([201, 200]);
  expect(ledger.records).toHaveLength(1);
  expect(ledger.records[0].totals).toMatchObject({ attempts: 2, makes: 1 });
  expect(await page.evaluate(key => localStorage.getItem(key), draftKey)).toBeNull();
});

test("another tab's draft change locks stale controls until reload restores the newer outcomes", async ({ page, context, ledger }) => {
  await start(page);
  await page.getByRole("button", { name: "Made", exact: true }).click();
  const second = await context.newPage();
  await second.goto("/training?drill=close-form");
  await expect(second.getByText("Session 1 / 1 made", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Missed", exact: true }).click();
  await expect(second.getByRole("status")).toContainText("Another tab changed the training draft");
  await expect(second.getByRole("button", { name: "Made", exact: true })).toBeDisabled();
  await expect(second.getByRole("button", { name: "Finish and save", exact: true })).toBeDisabled();
  await second.getByRole("button", { name: "Reload session", exact: true }).click();
  await expect(second.getByText("Session 1 / 2 made", { exact: true })).toBeVisible();
  await second.getByRole("button", { name: "Made", exact: true }).click();
  await expect(second.getByText("Session 2 / 3 made", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Another tab changed the training draft");
  await expect(page.getByRole("button", { name: "Missed", exact: true })).toBeDisabled();
  expect(ledger.posts).toHaveLength(0);
});

test("the runner fits a 375px screen and its main navigation reaches honest empty history", async ({ page, ledger }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await start(page);
  await page.getByRole("button", { name: "Made", exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.screenshot({ path: testInfo.outputPath("training-mobile.png"), fullPage: true });
  const link = page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Progress", exact: true });
  await link.click();
  await expect(page).toHaveURL(/\/progress$/);
  await expect(link).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "No training history yet", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "All saved training statistics" }).getByText("—", { exact: true })).toBeVisible();
  await expect(page.getByText("0%", { exact: true })).toHaveCount(0);
  expect(ledger.records).toHaveLength(0); // The unsaved browser draft is not history.
});

test("history service failures are visible and retry returns an empty state rather than invented performance", async ({ page, ledger }) => {
  ledger.failReads = true;
  await page.goto("/progress");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("temporarily unavailable");
  await expect(page.getByRole("heading", { name: "No training history yet", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "All saved training statistics" })).toHaveCount(0);
  ledger.failReads = false;
  await page.getByRole("button", { name: "Retry loading", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No training history yet", exact: true })).toBeVisible();
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "All saved training statistics" }).getByText("—", { exact: true })).toBeVisible();
  await expect(page.getByText("0%", { exact: true })).toHaveCount(0);
});

test("plan stages save separate drills and the next stage starts with its own fresh workload", async ({ page, ledger }) => {
  await start(page, "plan=smooth-foundation");
  await completeCloseForm(page, 0, true);
  await page.getByRole("button", { name: "Save session", exact: true }).click();
  await page.getByRole("link", { name: /Next: Quiet guide hand/ }).click();
  await expect(page).toHaveURL(/plan=smooth-foundation&step=1$/);
  await expect(page.getByRole("heading", { name: "Quiet guide hand", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Start recording", exact: true }).click();
  await expect(page.getByText("Set 1 / 3", { exact: true })).toBeVisible();
  await expect(page.getByText("Session 0 / 0 made", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Missed", exact: true }).click();
  await page.getByRole("button", { name: "Finish and save", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Session saved. Keep your own pace." })).toBeVisible();
  expect(ledger.records.map(item => [item.drill_id, item.status, item.totals.attempts])).toEqual([
    ["close-form", "completed", 24], ["guide-hand", "partial", 1],
  ]);
  expect(ledger.records[0].session_id).not.toBe(ledger.records[1].session_id);
});

test("resuming a plan draft restores its stage and keeps the next planned drill", async ({ page, ledger }) => {
  await start(page, "plan=smooth-foundation&step=1");
  await page.getByRole("button", { name: "Made", exact: true }).click();
  const savedDraft = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), draftKey);
  expect(savedDraft).toMatchObject({ drillId: "guide-hand", planId: "smooth-foundation", planStep: 1 });
  await page.goto("/");
  await page.goto("/training?plan=smooth-foundation");
  await expect(page.getByRole("heading", { name: "You have a session to resume", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Resume your session", exact: true }).click();
  await expect(page).toHaveURL(/plan=smooth-foundation&step=1$/);
  await expect(page.getByText("Session 1 / 1 made", { exact: true })).toBeVisible();
  for (let group = 0; group < 3; group++) {
    for (let attempt = group === 0 ? 1 : 0; attempt < 8; attempt++) {
      await page.getByRole("button", { name: "Missed", exact: true }).click();
    }
    if (group < 2) await page.getByRole("button", { name: "Skip rest", exact: true }).click();
  }
  await page.getByRole("button", { name: "Save session", exact: true }).click();
  await page.getByRole("link", { name: /Next: One-motion rhythm/ }).click();
  await expect(page).toHaveURL(/plan=smooth-foundation&step=2$/);
  await expect(page.getByRole("heading", { name: "One-motion rhythm", exact: true })).toBeVisible();
  expect(ledger.records).toHaveLength(1);
  expect(ledger.records[0]).toMatchObject({ drill_id: "guide-hand", status: "completed", totals: { attempts: 24, makes: 1 } });
});

test("a corrupt draft remains available for export until the player explicitly replaces it", async ({ page, ledger }) => {
  const damaged = "{unfinished-json";
  await page.addInitScript(({ key, raw }) => localStorage.setItem(key, raw), { key: draftKey, raw: damaged });
  await page.goto("/training?drill=close-form");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("The draft could not be read");
  expect(await page.evaluate(key => localStorage.getItem(key), draftKey)).toBe(damaged);
  await expect(page.getByRole("button", { name: "Export draft", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Replace unreadable draft and start", exact: true }).click();
  await expect(page.getByRole("button", { name: "Made", exact: true })).toBeEnabled();
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  expect(ledger.posts).toHaveLength(0);
});

function recoveredDraft(startedAt: string): TrainingDraft {
  return { version: 1, sessionId: "12345678-1234-4234-8234-123456789abc", drillId: "close-form", startedAt,
    sets: [[true], [], [], []], restUntil: null, revision: 2, pending: null };
}

test("a legal frozen save remains retryable after the working draft's seven-day age limit", async ({ page, ledger }) => {
  const started = Date.now() - 8 * 24 * 60 * 60 * 1000;
  const draft = recoveredDraft(new Date(started).toISOString());
  draft.pending = trainingInput(draft, new Date(started + 60_000).toISOString());
  await page.addInitScript(({ key, raw }) => localStorage.setItem(key, raw), { key: draftKey, raw: JSON.stringify(draft) });
  await page.goto("/training?drill=close-form");
  await expect(page.getByRole("button", { name: "Retry save", exact: true })).toBeEnabled();
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Retry save", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Session saved. Keep your own pace." })).toBeVisible();
  expect(ledger.posts).toEqual([draft.pending]);
  expect(ledger.records[0].totals.duration_ms).toBe(60_000);
  expect(await page.evaluate(key => localStorage.getItem(key), draftKey)).toBeNull();
});

test("a delayed successful save cannot delete a changed local draft that retains the same UUID", async ({ page, ledger }) => {
  let release!: () => void;
  ledger.holdResponse = new Promise<void>(resolve => { release = resolve; });
  await start(page);
  await page.getByRole("button", { name: "Made", exact: true }).click();
  await page.getByRole("button", { name: "Finish and save", exact: true }).click();
  try {
    await expect.poll(() => ledger.records.length).toBe(1);
    const updated = await page.evaluate(key => {
      const draft = JSON.parse(localStorage.getItem(key)!);
      draft.sets[0].push(false);
      draft.pending = null;
      draft.revision++;
      const raw = JSON.stringify(draft);
      localStorage.setItem(key, raw);
      return raw;
    }, draftKey);
    release();
    await expect(page.getByRole("heading", { name: "Session saved. Keep your own pace." })).toBeVisible();
    expect(await page.evaluate(key => localStorage.getItem(key), draftKey)).toBe(updated);
    await page.reload();
    await expect(page.getByText("Session 1 / 2 made", { exact: true })).toBeVisible();
    expect(ledger.records[0].totals).toMatchObject({ attempts: 1, makes: 1 });
  } finally { release(); }
});

test("draft recovery rejects impossible clocks before offering a frozen save", () => {
  const startedMs = Date.now() - 60_000;
  const started = new Date(startedMs).toISOString();
  expect(parseDraft(JSON.stringify(recoveredDraft(started))).startedAt).toBe(started);
  for (const invalid of [started.slice(0, -1), "2026-02-30T10:00:00.000Z"]) {
    expect(() => parseDraft(JSON.stringify(recoveredDraft(invalid)))).toThrow();
  }
  for (const invalid of ["not-a-date", new Date(startedMs - 1).toISOString(), new Date(startedMs + 7 * 24 * 60 * 60 * 1000 + 1).toISOString()]) {
    const draft = recoveredDraft(started);
    draft.pending = trainingInput(draft, invalid);
    expect(() => parseDraft(JSON.stringify(draft))).toThrow();
  }
});
