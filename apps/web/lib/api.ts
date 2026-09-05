/** Typed client for the OneMotion API (docs/ARCHITECTURE.md §6). */

const PUBLIC_API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";
export const API_BASE =
  typeof window === "undefined"
    ? process.env.ONEMOTION_API_BASE ?? PUBLIC_API_BASE
    : PUBLIC_API_BASE;

export function apiUrl(path: string | null): string | null {
  if (!path) return null;
  return path.startsWith("http") ? path : `${API_BASE}${path}`;
}

export type PhaseName = "dip" | "load" | "lift" | "release" | "follow_through";
export type TimingMode = "realtime" | "slow_motion" | "unknown";

export type PhaseSegment = {
  phase: PhaseName;
  start_frame: number;
  end_frame: number;
  start_ms: number;
  end_ms: number;
  anchor_frame: number | null;
  anchor_ms: number | null;
  degraded: boolean;
  censored: boolean;
};

export type MetricValue = {
  name: string;
  value: number | null;
  benchmark_median: number | null;
  benchmark_range: [number, number] | null;
  delta: number | null;
  delta_pct: number | null;
  category: "form" | "timing";
  confidence: number;
  coverage: number;
  benchmark_sample_count: number | null;
  robust_z_score: number | null;
  reliable: boolean;
  unavailable_reason: string | null;
};

export type FeedbackItem = {
  rank: number;
  metric: string;
  phase: PhaseName | null;
  message: string;
  cue: string;
  confidence: number;
  severity: number | null;
  player_value: number | null;
  benchmark_value: number | null;
  benchmark_range: [number, number] | null;
  benchmark_sample_count: number | null;
};

export type AnalysisQuality = {
  status: "valid" | "degraded" | "insufficient";
  coverage: number;
  valid_metrics: number;
  expected_metrics: number;
  missing_metrics: string[];
  degraded_phases: PhaseName[];
  reasons: string[];
};

export type CaptureQuality = {
  status: "pass" | "warn" | "fail";
  side_view_score: number;
  confidence: number;
  body_visibility: number;
  projected_body_width_ratio: number | null;
  reasons: string[];
  guidance: string[];
  method: string;
};

export type AnalysisResult = {
  analysis_id: string;
  benchmark_version: string;
  similarity_score: number | null;
  form_score: number | null;
  timing_score: number | null;
  template_id: string | null;
  template_name: string | null;
  timing_mode: TimingMode;
  timing_reliable: boolean;
  quality: AnalysisQuality | null;
  capture_quality: CaptureQuality | null;
  phases: PhaseSegment[];
  metrics: MetricValue[];
  feedback: FeedbackItem[];
  benchmark_phases: PhaseSegment[] | null;
  player_video_url: string | null;
  template_video_url: string | null;
  media_expires_at: string | null;
};

export type Keypoint = {
  name: string;
  x: number;
  y: number;
  confidence: number;
};

export type PoseFrame = {
  frame_idx: number;
  t_ms: number;
  keypoints: Keypoint[];
};

export type ShotSequence = {
  clip_id: string;
  fps: number;
  width: number;
  height: number;
  frames: PoseFrame[];
};

export type ReplayPayload = {
  analysis_id: string;
  template_id: string;
  timing_mode: TimingMode;
  timing_reliable: boolean;
  player_sequence: ShotSequence;
  player_phases: PhaseSegment[];
  template_sequence: ShotSequence;
  template_phases: PhaseSegment[];
  player_video_url: string | null;
  template_video_url: string | null;
  player_window: ReplayWindow;
  template_window: ReplayWindow;
  sync: ReplaySync;
  biomechanics_version: string;
  player_biomechanics: BiomechanicsFrame[];
  template_biomechanics: BiomechanicsFrame[];
};

export type DerivedValue = {
  value: number | null;
  confidence: number;
  reliable: boolean;
  interpolated: boolean;
  unavailable_reason: string | null;
};

export type BiomechanicsFrame = {
  frame_idx: number;
  t_ms: number;
  phase: PhaseName | null;
  shooting_side: "left" | "right";
  is_release_frame: boolean;
  elbow_flexion_deg: DerivedValue;
  left_knee_flexion_deg: DerivedValue;
  right_knee_flexion_deg: DerivedValue;
  forearm_elevation_deg: DerivedValue;
  release_angle_proxy_deg: DerivedValue;
  trunk_lean_deg: DerivedValue;
  wrist_vertical_velocity_height_s: DerivedValue;
};

export type ReplayWindow = {
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  fps: number;
  dip_anchor_ms: number;
  release_anchor_ms: number;
};

export type ReplaySync = {
  available_modes: ("independent" | "realtime_locked")[];
  default_mode: "independent" | "realtime_locked";
  default_anchor: "dip" | "release";
  anchors: {
    name: "dip" | "release";
    player_ms: number;
    template_ms: number;
    confidence: number;
  }[];
  unavailable_reason: string | null;
};

export async function health(): Promise<Response> {
  return fetch(`${API_BASE}/health`);
}

export async function submitAnalysis(file: File, signal?: AbortSignal): Promise<Response> {
  const form = new FormData();
  form.append("video", file);
  return fetch(`${API_BASE}/api/v1/analysis`, { method: "POST", body: form, signal });
}

export async function getAnalysis(id: string): Promise<Response> {
  return fetch(`${API_BASE}/api/v1/analysis/${id}`, { cache: "no-store" });
}

export async function getReplay(id: string, signal?: AbortSignal): Promise<ReplayPayload> {
  const response = await fetch(`${API_BASE}/api/v1/analysis/${id}/replay`, {
    signal,
    cache: "no-store",
  });
  if (!response.ok) throw await responseError(response);
  return response.json();
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export async function responseError(response: Response): Promise<ApiError> {
  const body = await response.json().catch(() => null);
  const detail = body?.detail ?? body?.error?.message;
  const defaults: Record<number, string> = {
    404: "This analysis could not be found. Record or upload a new shot.",
    410: "This replay has expired. Your report is still available; upload a new shot for video replay.",
    429: "The analysis service is busy. Try again shortly.",
    503: "The analysis service is temporarily unavailable. Please try again later.",
  };
  return new ApiError(response.status, defaults[response.status] ??
    (typeof detail === "string" ? detail : `The request failed (${response.status}). Please try again.`));
}
