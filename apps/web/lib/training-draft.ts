import { getDrill, workoutPlans, type Drill } from "./drills";
import type { TrainingInput } from "./training-api";

export const DRAFT_KEY = "onemotion.training.draft.v1";
export const MAX_DRAFT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export type TrainingDraft = {
  version: 1;
  sessionId: string;
  drillId: string;
  startedAt: string;
  sets: boolean[][];
  restUntil: number | null;
  revision: number;
  planId?: string;
  planStep?: number;
  /** Freeze the exact request after the first save, including uncertain failures. */
  pending: TrainingInput | null;
};

function uuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function isoClock(value: unknown): number {
  if (typeof value !== "string") return NaN;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
  if (!parts) return NaN;
  const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) return NaN;
  return Date.parse(value);
}
export function createDraft(drill: Drill, context?: { planId: string; planStep: number }): TrainingDraft {
  return { version: 1, sessionId: uuid(), drillId: drill.id, startedAt: new Date().toISOString(),
    sets: Array.from({ length: drill.sets }, () => []), restUntil: null, revision: 0, pending: null, ...context };
}
export function parseDraft(raw: string): TrainingDraft {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object") throw new Error("Invalid draft");
  const draft = value as TrainingDraft;
  const drill = getDrill(draft.drillId);
  const clock = isoClock(draft.startedAt);
  if (draft.version !== 1 || !drill || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(draft.sessionId)
    || !Number.isFinite(clock) || clock > Date.now() + 60_000
    || !Number.isSafeInteger(draft.revision) || draft.revision < 0
    || (draft.restUntil !== null && (!Number.isSafeInteger(draft.restUntil) || draft.restUntil < 0))
    || !Array.isArray(draft.sets) || draft.sets.length !== drill.sets
    || draft.sets.some(set => !Array.isArray(set) || set.length > drill.reps || set.some(shot => typeof shot !== "boolean"))) throw new Error("Could not read the training draft");
  const firstUnfinished = draft.sets.findIndex(set => set.length < drill.reps);
  if (firstUnfinished >= 0 && draft.sets.slice(firstUnfinished + 1).some(set => set.length > 0)) throw new Error("Draft set order is invalid");
  if (draft.planId !== undefined || draft.planStep !== undefined) {
    const plan = workoutPlans.find(item => item.id === draft.planId);
    if (!plan || !Number.isInteger(draft.planStep) || plan.drillIds[draft.planStep!] !== draft.drillId) throw new Error("Draft workout plan is invalid");
  }
  if (draft.pending !== null) {
    const pending = draft.pending;
    const completedClock = isoClock(pending?.completed_at);
    if (!Number.isFinite(completedClock) || completedClock < clock || completedClock - clock > MAX_DRAFT_AGE_MS) throw new Error("Pending session times are invalid");
    const expected = trainingInput({ ...draft, pending: null }, pending?.completed_at);
    if (!pending || JSON.stringify(pending) !== JSON.stringify(expected)) throw new Error("Pending session does not match the draft");
  }
  return draft;
}
export function trainingInput(draft: TrainingDraft, completedAt = new Date().toISOString()): TrainingInput {
  const drill = getDrill(draft.drillId);
  if (!drill) throw new Error("This drill is no longer available");
  const complete = draft.sets.every(set => set.length === drill.reps);
  const last = draft.sets.findLastIndex(set => set.length > 0);
  return { session_id: draft.sessionId, drill_id: draft.drillId, started_at: draft.startedAt, completed_at: completedAt,
    planned_sets: drill.sets, planned_reps: drill.reps, sets: draft.sets.slice(0, last + 1).map(attempts => ({ attempts })), status: complete ? "completed" : "partial" };
}
export function addShot(draft: TrainingDraft, made: boolean, now = Date.now()): TrainingDraft {
  const drill = getDrill(draft.drillId)!;
  const index = draft.sets.findIndex(set => set.length < drill.reps);
  if (index < 0 || draft.pending || (draft.restUntil !== null && draft.restUntil > now)) return draft;
  const sets = draft.sets.map((set, i) => i === index ? [...set, made] : set);
  const restUntil = sets[index].length === drill.reps && index < sets.length - 1 ? now + drill.restSeconds * 1000 : null;
  return { ...draft, sets, restUntil, revision: draft.revision + 1 };
}
export function undoShot(draft: TrainingDraft): TrainingDraft {
  if (draft.pending) return draft;
  const index = draft.sets.findLastIndex(set => set.length > 0);
  if (index < 0) return draft;
  return { ...draft, sets: draft.sets.map((set, i) => i === index ? set.slice(0, -1) : set), restUntil: null, revision: draft.revision + 1 };
}
