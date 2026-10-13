import { API_BASE, responseError } from "./api";

export type TrainingInput = {
  session_id: string;
  drill_id: string;
  started_at: string;
  completed_at: string;
  planned_sets: number;
  planned_reps: number;
  sets: { attempts: boolean[] }[];
  status: "completed" | "partial";
};
export type TrainingTotals = {
  attempts: number;
  makes: number;
  accuracy_pct: number | null;
  duration_ms: number;
  completed_sets: number;
};
export type TrainingSession = TrainingInput & { totals: TrainingTotals; created_at: string };
export type TrainingSummary = Omit<TrainingTotals, "completed_sets"> & { sessions: number; completed_sessions: number };
export type TrainingHistory = { sessions: TrainingSession[]; summary: TrainingSummary; has_more: boolean };

export async function saveTraining(input: TrainingInput, signal?: AbortSignal): Promise<TrainingSession> {
  const response = await fetch(`${API_BASE}/api/v1/training/sessions`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal,
  });
  if (!response.ok) throw await responseError(response);
  return response.json();
}
export async function getTrainingHistory(signal?: AbortSignal): Promise<TrainingHistory> {
  const response = await fetch(`${API_BASE}/api/v1/training/sessions?limit=100`, { cache: "no-store", signal });
  if (!response.ok) throw await responseError(response);
  return response.json();
}
export function accuracyLabel(makes: number, attempts: number): string {
  return attempts ? `${Math.round(makes / attempts * 100)}%` : "—";
}
export function durationLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
