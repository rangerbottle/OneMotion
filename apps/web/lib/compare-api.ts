/** Typed client for the frame-by-frame action comparison API. */

import { API_BASE, responseError } from "./api";
import type { ShotSequence } from "./api";

export type Player = {
  player_id: string;
  name: string;
  created_at: string;
};

export type ActionTemplate = {
  template_id: string;
  player_id: string;
  name: string;
  default_phases: string[];
};

export type CameraCheckResult = {
  status: "match" | "suspect" | "mismatch";
  inlier_ratio: number;
  matches: number;
  homography: number[][] | null;
};

export type ClipMeta = {
  clip_id: string;
  player_id: string;
  template_id: string;
  kind: "baseline" | "comparison";
  filename: string;
  fps: number;
  width: number;
  height: number;
  frame_count: number;
  duration_ms: number;
  camera: CameraCheckResult | null;
  created_at: string;
};

export type AffineTransform = {
  tx: number;
  ty: number;
  scale: number;
  rotation_deg: number;
};

export type TemporalAlignment = {
  offset_ms_a: number;
  offset_ms_b: number;
  suggested_offset_ms_b: number | null;
  suggestion_confidence: number | null;
};

export type PhaseBoundary = {
  phase: string;
  start_frame: number;
  end_frame: number;
};

export type EventMarker = {
  marker_id: string;
  side: "a" | "b" | "both";
  frame: number;
  t_ms: number;
  text: string;
  created_at: string;
};

export type KeyframeRef = {
  url: string;
  t_ms_a: number;
  t_ms_b: number;
  deviation: number;
};

export type PhaseOffset = {
  phase: string;
  delta_frames: number;
  delta_ms: number;
};

export type ReportRef = {
  created_at: string;
  keyframes: KeyframeRef[];
  phase_offsets: PhaseOffset[];
  summary_text: string;
};

export type AngleSeriesPoint = {
  t_ms: number;
  value: number | null;
  confidence: number;
};

export type ComparisonMetrics = {
  a: Record<string, AngleSeriesPoint[]>;
  b: Record<string, AngleSeriesPoint[]>;
};

export type ComparisonState = {
  comparison_id: string;
  player_id: string;
  template_id: string;
  baseline_clip_id: string;
  comparison_clip_id: string;
  spatial: AffineTransform;
  opacity_default: number;
  temporal: TemporalAlignment;
  phases_a: PhaseBoundary[];
  phases_b: PhaseBoundary[];
  markers: EventMarker[];
  camera_check: CameraCheckResult | null;
  report: ReportRef | null;
  created_at: string;
};

export type ComparisonSummary = {
  comparison_id: string;
  template_id: string;
  baseline_clip_id: string;
  comparison_clip_id: string;
  camera_status: string;
  created_at: string;
};

export type PlayerDetail = {
  player: Player;
  templates: ActionTemplate[];
  clips: ClipMeta[];
  comparisons: ComparisonSummary[];
};

export type ClipKind = "baseline" | "comparison";

async function parseJson<T>(input: Promise<Response> | Response): Promise<T> {
  const response = await input;
  if (!response.ok) throw await responseError(response);
  return response.json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseJson<T>(response);
}

export function createPlayer(name: string): Promise<Player> {
  return postJson<Player>("/api/v1/compare/players", { name });
}

export function listPlayers(): Promise<Player[]> {
  return parseJson<Player[]>(
    fetch(`${API_BASE}/api/v1/compare/players`, { cache: "no-store" }),
  );
}

export function getPlayer(playerId: string): Promise<PlayerDetail> {
  return parseJson<PlayerDetail>(
    fetch(`${API_BASE}/api/v1/compare/players/${playerId}`, { cache: "no-store" }),
  );
}

export async function deletePlayer(playerId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/api/v1/compare/players/${playerId}`, {
    method: "DELETE",
  });
  if (!response.ok) throw await responseError(response);
}

export function createTemplate(
  playerId: string,
  name: string,
  defaultPhases: string[],
): Promise<ActionTemplate> {
  return postJson<ActionTemplate>(`/api/v1/compare/players/${playerId}/templates`, {
    name,
    default_phases: defaultPhases,
  });
}

export function uploadClip(
  playerId: string,
  input: { video: File; templateId: string; kind: ClipKind },
): Promise<Response> {
  const form = new FormData();
  form.append("video", input.video);
  form.append("template_id", input.templateId);
  form.append("kind", input.kind);
  return fetch(`${API_BASE}/api/v1/compare/players/${playerId}/clips`, {
    method: "POST",
    body: form,
  });
}

export function getClip(clipId: string): Promise<ClipMeta> {
  return parseJson<ClipMeta>(
    fetch(`${API_BASE}/api/v1/compare/clips/${clipId}`, { cache: "no-store" }),
  );
}

export function getClipPose(clipId: string): Promise<ShotSequence> {
  return parseJson<ShotSequence>(
    fetch(`${API_BASE}/api/v1/compare/clips/${clipId}/pose`, { cache: "no-store" }),
  );
}

export function clipVideoUrl(clipId: string): string {
  return `${API_BASE}/api/v1/compare/clips/${clipId}/video`;
}

export async function deleteClip(clipId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/api/v1/compare/clips/${clipId}`, {
    method: "DELETE",
  });
  if (!response.ok) throw await responseError(response);
}

export function createComparison(input: {
  playerId: string;
  templateId: string;
  baselineClipId: string;
  comparisonClipId: string;
}): Promise<ComparisonState> {
  return postJson<ComparisonState>("/api/v1/compare/comparisons", {
    player_id: input.playerId,
    template_id: input.templateId,
    baseline_clip_id: input.baselineClipId,
    comparison_clip_id: input.comparisonClipId,
  });
}

export function getComparison(comparisonId: string): Promise<ComparisonState> {
  return parseJson<ComparisonState>(
    fetch(`${API_BASE}/api/v1/compare/comparisons/${comparisonId}`, { cache: "no-store" }),
  );
}

export type ComparisonPatch =
  & Partial<Pick<ComparisonState, "spatial" | "opacity_default" | "phases_a" | "phases_b" | "markers">>
  & { temporal?: Partial<ComparisonState["temporal"]> };

export function patchComparison(
  comparisonId: string,
  patch: ComparisonPatch,
): Promise<ComparisonState> {
  return parseJson<ComparisonState>(
    fetch(`${API_BASE}/api/v1/compare/comparisons/${comparisonId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),
  );
}

export function comparisonVideoUrl(comparisonId: string, side: "a" | "b"): string {
  return `${API_BASE}/api/v1/compare/comparisons/${comparisonId}/video/${side}`;
}

export function getComparisonMetrics(comparisonId: string): Promise<ComparisonMetrics> {
  return parseJson<ComparisonMetrics>(
    fetch(`${API_BASE}/api/v1/compare/comparisons/${comparisonId}/metrics`, { cache: "no-store" }),
  );
}

export function generateComparisonReport(comparisonId: string): Promise<ComparisonState> {
  return postJson<ComparisonState>(`/api/v1/compare/comparisons/${comparisonId}/report`, {});
}

export async function deleteComparison(comparisonId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/api/v1/compare/comparisons/${comparisonId}`, {
    method: "DELETE",
  });
  if (!response.ok) throw await responseError(response);
}
