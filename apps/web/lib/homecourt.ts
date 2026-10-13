import type { HomeCourtSourceInput } from "./api";

export const MAX_HOMECOURT_BYTES = 200 * 1024 * 1024;
export const MAX_HOMECOURT_SECONDS = 600;
export const MAX_SHOT_MS = 12_000;

export function validateHomeCourtFile(file: File): void {
  if (!/\.(mp4|mov|webm)$/i.test(file.name)) throw new Error("Choose an MP4, MOV or WebM video.");
  if (!file.size) throw new Error("The video file is empty. Choose another file.");
  if (file.size > MAX_HOMECOURT_BYTES) throw new Error("The original video exceeds 200 MB. Export a shorter practice video first.");
}

export function validateHomeCourtSource(source: HomeCourtSourceInput, durationMs?: number): void {
  if (!Number.isInteger(source.start_ms) || !Number.isInteger(source.end_ms) || source.start_ms < 0 || source.end_ms <= source.start_ms) {
    throw new Error("Set valid start and end times for the shot.");
  }
  if (source.end_ms - source.start_ms > MAX_SHOT_MS) throw new Error("Select one complete shot of no more than 12 seconds.");
  if (durationMs !== undefined && source.end_ms > durationMs) throw new Error("The selection exceeds the original video duration.");
  if (source.recorded_at && !Number.isFinite(Date.parse(source.recorded_at))) throw new Error("The practice time is invalid.");
  const roi = source.subject_roi;
  if (roi && (![roi.x, roi.y, roi.width, roi.height].every(Number.isFinite) || roi.x < 0 || roi.y < 0 || roi.width <= 0 || roi.height <= 0 || roi.x + roi.width > 1 || roi.y + roi.height > 1)) {
    throw new Error("Draw a new person region within the video frame.");
  }
}

/** Validate the original file; range controls do not create a trimmed File. */
export async function validateHomeCourtImport(file: File, source: HomeCourtSourceInput, signal?: AbortSignal): Promise<void> {
  validateHomeCourtFile(file);
  validateHomeCourtSource(source);
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      video.onloadedmetadata = null;
      video.onerror = null;
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      if (error) reject(error); else resolve();
    };
    const abort = () => finish(new DOMException("Cancelled", "AbortError"));
    const timer = setTimeout(() => finish(new Error("Could not read the original video. Try another file.")), 10_000);
    signal?.addEventListener("abort", abort, { once: true });
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      try {
        if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error("Could not determine the original video duration. Try exporting an MP4 video.");
        if (video.duration > MAX_HOMECOURT_SECONDS) throw new Error("The original video exceeds 10 minutes. Export a shorter practice video first.");
        validateHomeCourtSource(source, Math.round(video.duration * 1000));
        finish();
      } catch (error) {
        finish(error instanceof Error ? error : new Error("The video selection is invalid."));
      }
    };
    video.onerror = () => finish(new Error("This browser cannot preview the video. Try MP4 or WebM."));
    video.src = url;
  });
}
