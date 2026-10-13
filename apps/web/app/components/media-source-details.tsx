import type { MediaSource } from "@/lib/api";

const SPEED_LABEL = {
  realtime: "Real time, as declared by the uploader",
  slow_motion: "Slow motion",
  unknown: "Playback speed unknown",
};

export default function MediaSourceDetails({ source, title = "Practice source" }: {
  source?: MediaSource | null;
  title?: string;
}) {
  if (!source) return null;
  return <section aria-label={title} className="surface space-y-2 p-5 text-sm">
    <h2 className="font-medium">{title} · HomeCourt</h2>
    <p className="break-all text-[var(--muted)]">{source.original_filename}</p>
    <p>Source interval: {(source.start_ms / 1000).toFixed(2)}–{(source.end_ms / 1000).toFixed(2)} seconds · {SPEED_LABEL[source.timing_mode]}</p>
    {source.requested_start_ms != null && source.requested_end_ms != null &&
      (source.requested_start_ms !== source.start_ms || source.requested_end_ms !== source.end_ms) ?
      <p className="text-[var(--muted)]">Requested interval: {(source.requested_start_ms / 1000).toFixed(2)}–{(source.requested_end_ms / 1000).toFixed(2)} seconds, aligned to the original video’s actual frame boundaries.</p> : null}
    {source.recorded_at ? <p>Practice time: <time dateTime={source.recorded_at}>{source.recorded_at.replace("T", " ")}</time></p> : null}
    {source.camera_label ? <p>Camera: {source.camera_label}</p> : null}
    {source.subject_roi ? <p>The selected region identifies the shooter. Replay preserves the full video frame.</p> : null}
    {source.timing_mode !== "realtime" ? <p className="text-[var(--accent)]">This source supports replay and eligible pose comparisons. Timing and velocity conclusions are disabled.</p> : null}
  </section>;
}
