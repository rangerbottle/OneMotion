import { ApiError, type ShotSequence } from "@/lib/api";
import {
  generateComparisonReport, getClip, getClipPose, getComparison,
  getComparisonMetrics, patchComparison,
  type AffineTransform, type ClipMeta, type ComparisonMetrics,
  type ComparisonPatch, type ComparisonState,
} from "@/lib/compare-api";

type WorkbenchData = {
  comparison: ComparisonState;
  clipA: ClipMeta;
  clipB: ClipMeta;
  poseA: ShotSequence;
  poseB: ShotSequence;
  metrics: ComparisonMetrics;
  initialSpatial: AffineTransform;
};

type Snapshot = {
  data: WorkbenchData | null;
  loading: boolean;
  notFound: boolean;
  loadError: string | null;
  saveStatus: "saved" | "pending" | "saving" | "failed";
  saveError: string | null;
  reporting: boolean;
  reportError: string | null;
};

const INITIAL: Snapshot = {
  data: null, loading: true, notFound: false, loadError: null,
  saveStatus: "saved", saveError: null, reporting: false, reportError: null,
};

// Controllers are remounted on navigation. Keep only unfinished write tails
// across those lifetimes, so returning to an ID cannot overtake its old save.
const pendingWrites = new Map<string, Promise<void>>();

function enqueueWrite(comparisonId: string, write: () => Promise<void>): Promise<void> {
  const operation = (pendingWrites.get(comparisonId) ?? Promise.resolve()).then(write);
  // Failed writes still release the queue for explicit retries/newer edits.
  const tail = operation.catch(() => undefined);
  pendingWrites.set(comparisonId, tail);
  void tail.then(() => {
    if (pendingWrites.get(comparisonId) === tail) pendingWrites.delete(comparisonId);
  });
  return operation;
}

async function waitForWrites(comparisonId: string) {
  // A cleanup can extend an existing tail. Recheck it before loading server
  // state rather than taking a constructor-time snapshot of the queue.
  let tail = pendingWrites.get(comparisonId);
  while (tail) {
    await tail;
    tail = pendingWrites.get(comparisonId);
  }
}

function mergePatch(previous: ComparisonPatch, next: ComparisonPatch): ComparisonPatch {
  const merged = { ...previous, ...next };
  if (next.temporal) merged.temporal = { ...previous.temporal, ...next.temporal };
  return merged;
}

function applyPatch(state: ComparisonState, patch: ComparisonPatch): ComparisonState {
  const next = { ...state, ...patch, temporal: { ...state.temporal, ...patch.temporal } };
  if (patch.spatial || patch.temporal || patch.phases_a || patch.phases_b) next.report = null;
  return next;
}

/** One comparison owns one queue. UI lifetime guards never change its request ID. */
export class ComparisonController {
  private snapshot: Snapshot = INITIAL;
  private listeners = new Set<() => void>();
  private active = false;
  private generation = 0;
  private readRequest: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSave: Promise<void> = Promise.resolve();
  private dirty: ComparisonPatch = {};
  private retryDraft: ComparisonPatch | null = null;
  private revision = 0;
  private queuedRevision = 0;

  constructor(private readonly comparisonId: string) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getSnapshot = () => this.snapshot;
  getServerSnapshot = () => INITIAL;

  private publish(update: Partial<Snapshot>) {
    if (!this.active) return;
    this.snapshot = { ...this.snapshot, ...update };
    this.listeners.forEach((listener) => listener());
  }

  private isCurrent(generation: number) {
    return this.active && this.generation === generation;
  }

  start = () => {
    this.active = true;
    this.retryLoad();
  };

  stop = () => {
    // Preserve edits made just before navigation. Only the captured old ID is
    // used; completed saves cannot publish into a later mount/comparison.
    this.active = false;
    this.generation += 1;
    this.readRequest?.abort();
    void this.flush().catch(() => undefined);
  };

  retryLoad = () => {
    this.readRequest?.abort();
    const request = new AbortController();
    this.readRequest = request;
    const generation = ++this.generation;
    this.publish({ ...INITIAL });
    void (async () => {
      // A fresh controller for this ID must also await a previous mount's save.
      await waitForWrites(this.comparisonId);
      if (!this.isCurrent(generation)) return;
      const [comparison, metrics] = await Promise.all([
        getComparison(this.comparisonId, request.signal),
        getComparisonMetrics(this.comparisonId, request.signal),
      ]);
      const [clipA, clipB, poseA, poseB] = await Promise.all([
        getClip(comparison.baseline_clip_id, request.signal),
        getClip(comparison.comparison_clip_id, request.signal),
        getClipPose(comparison.baseline_clip_id, request.signal),
        getClipPose(comparison.comparison_clip_id, request.signal),
      ]);
      if (!this.isCurrent(generation)) return;
      this.dirty = {};
      this.retryDraft = null;
      this.revision = this.queuedRevision = 0;
      this.lastSave = Promise.resolve();
      this.publish({ loading: false, data: { comparison, metrics, clipA, clipB, poseA, poseB, initialSpatial: comparison.spatial } });
    })().catch((error: unknown) => {
      if (!this.isCurrent(generation)) return;
      this.publish({
        loading: false,
        notFound: error instanceof ApiError && error.status === 404,
        loadError: error instanceof Error ? error.message : "Could not load comparison data.",
      });
    });
  };

  patch = (patch: ComparisonPatch) => {
    const data = this.snapshot.data;
    if (!this.active || !data) return;
    this.revision += 1;
    // Keep unacknowledged fields in every later request: if an earlier write
    // fails (including a displayed rollback), a new edit still saves both.
    // New values win for the same field; temporal subfields stay independent.
    this.dirty = mergePatch(mergePatch(this.retryDraft ?? {}, this.dirty), patch);
    this.retryDraft = null;
    this.publish({
      data: { ...data, comparison: applyPatch(data.comparison, this.dirty) },
      saveStatus: "pending", saveError: null, reportError: null,
    });
    this.clearTimer();
    this.timer = setTimeout(() => { void this.flush().catch(() => undefined); }, 600);
  };

  private clearTimer() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  flush = (): Promise<void> => {
    this.clearTimer();
    if (!Object.keys(this.dirty).length || this.queuedRevision === this.revision) return this.lastSave;
    const body = this.dirty;
    const revision = this.revision;
    const generation = this.generation;
    this.queuedRevision = revision;
    this.publish({ saveStatus: "saving" });
    const save = enqueueWrite(this.comparisonId, async () => {
      try {
        const updated = await patchComparison(this.comparisonId, body);
        if (!this.isCurrent(generation) || revision !== this.revision) return;
        this.dirty = {};
        this.retryDraft = null;
        const data = this.snapshot.data;
        if (data) this.publish({ data: { ...data, comparison: updated }, saveStatus: "saved", saveError: null });
      } catch (error) {
        if (this.isCurrent(generation) && revision === this.revision) {
          await this.recoverFailedSave(body, revision, generation);
        }
        throw error;
      }
    });
    this.lastSave = save;
    return save;
  };

  private async recoverFailedSave(body: ComparisonPatch, revision: number, generation: number) {
    try {
      const fresh = await getComparison(this.comparisonId, this.readRequest?.signal);
      if (!this.isCurrent(generation) || revision !== this.revision) return;
      this.dirty = {};
      this.retryDraft = body;
      const data = this.snapshot.data;
      if (data) this.publish({
        data: { ...data, comparison: fresh }, saveStatus: "failed",
        saveError: "Save failed. The server version has been restored. You can retry your changes.",
      });
    } catch {
      if (!this.isCurrent(generation) || revision !== this.revision) return;
      this.publish({ saveStatus: "failed", saveError: "Save failed. Your changes are still unsaved. Check your connection and try again." });
    }
  }

  retrySave = () => {
    const draft = this.retryDraft ?? this.dirty;
    if (!this.active || !Object.keys(draft).length) return;
    this.patch(draft);
    void this.flush().catch(() => undefined);
  };

  exportReport = async () => {
    if (!this.active || this.snapshot.reporting || !this.snapshot.data) return;
    const generation = this.generation;
    const revision = this.revision;
    const data = this.snapshot.data;
    this.publish({ reporting: true, reportError: null, data: { ...data, comparison: { ...data.comparison, report: null } } });
    try {
      await this.flush();
      if (!this.isCurrent(generation)) return;
      // Report generation writes the comparison too, so it shares the save
      // queue. Edits during generation are saved after it, never overwritten.
      const report = enqueueWrite(this.comparisonId, async () => {
        if (!this.isCurrent(generation)) return;
        if (revision !== this.revision) throw new Error("Alignment changed. Generate the report again.");
        const updated = await generateComparisonReport(this.comparisonId);
        if (!this.isCurrent(generation)) return;
        if (revision !== this.revision) throw new Error("Alignment changed. Generate the report again.");
        const current = this.snapshot.data;
        if (current) this.publish({ data: { ...current, comparison: updated } });
      });
      await report;
    } catch (error) {
      if (this.isCurrent(generation)) this.publish({
        reportError: error instanceof Error && error.message === "Alignment changed. Generate the report again."
          ? error.message : "Report generation failed. Check the save status and try again.",
      });
    } finally {
      if (this.isCurrent(generation)) this.publish({ reporting: false });
    }
  };
}
