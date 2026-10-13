"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import type { HomeCourtSourceInput, SubjectROI, TimingMode } from "@/lib/api";
import { MAX_HOMECOURT_SECONDS, MAX_SHOT_MS, validateHomeCourtFile, validateHomeCourtSource } from "@/lib/homecourt";

export type HomeCourtSelection = { file: File; source: HomeCourtSourceInput };

const inputClass = "min-h-11 w-full min-w-0 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 text-[var(--foreground)]";
const buttonClass = "button-secondary";
const clamp = (value: number) => Math.max(0, Math.min(1, value));

/** Select an original-file interval and person. Only the backend trims the video. */
export default function HomeCourtClipSelector({ disabled = false, onSelect }: {
  disabled?: boolean;
  onSelect: (selection: HomeCourtSelection | null) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [aspectRatio, setAspectRatio] = useState(16 / 9);
  const [startMs, setStartMs] = useState(0);
  const [endMs, setEndMs] = useState(0);
  const [loop, setLoop] = useState(false);
  const [timingMode, setTimingMode] = useState<TimingMode>("unknown");
  const [recordedAt, setRecordedAt] = useState("");
  const [cameraLabel, setCameraLabel] = useState("");
  const [multiplePeople, setMultiplePeople] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [roi, setRoi] = useState<SubjectROI | undefined>();
  const [drawing, setDrawing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [playbackMessage, setPlaybackMessage] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const previewingRef = useRef(false);

  useEffect(() => () => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
  }, []);

  const candidate = useMemo((): { source: HomeCourtSourceInput | null; error: string | null } => {
    if (!file || durationMs === null || message) return { source: null, error: null };
    try {
      const recordedDate = recordedAt ? new Date(recordedAt) : null;
      if (recordedDate && !Number.isFinite(recordedDate.getTime())) throw new Error("Enter a valid practice time.");
      const source: HomeCourtSourceInput = {
        provider: "homecourt", start_ms: startMs, end_ms: endMs, timing_mode: timingMode,
        ...(recordedDate ? { recorded_at: recordedDate.toISOString() } : {}),
        ...(cameraLabel.trim() ? { camera_label: cameraLabel.trim() } : {}),
        ...(multiplePeople && roi ? { subject_roi: roi } : {}),
      };
      validateHomeCourtSource(source, durationMs);
      return { source, error: null };
    } catch (error) {
      return { source: null, error: error instanceof Error ? error.message : "Select a valid shot interval." };
    }
  }, [file, durationMs, message, startMs, endMs, timingMode, recordedAt, cameraLabel, multiplePeople, roi]);
  const selection = useMemo(() => file && candidate.source && confirmed && (!multiplePeople || roi) && !drawing
    ? { file, source: candidate.source } : null, [file, candidate.source, confirmed, multiplePeople, roi, drawing]);
  useEffect(() => { onSelect(selection); }, [selection, onSelect]);

  function selectFile(next: File | null) {
    if (disabled) return;
    videoRef.current?.pause();
    previewingRef.current = false;
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    setPreviewUrl(null);
    setFile(null);
    setDurationMs(null);
    setMessage(null);
    setPlaybackMessage(null);
    setStartMs(0);
    setEndMs(0);
    setTimingMode("unknown");
    setConfirmed(false);
    setRoi(undefined);
    setDrawing(false);
    dragRef.current = null;
    if (!next) return;
    try {
      validateHomeCourtFile(next);
      urlRef.current = URL.createObjectURL(next);
      setFile(next);
      setPreviewUrl(urlRef.current);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Choose a valid video.");
    }
  }

  // Account for object-contain bars even if the preview's layout changes later.
  function pointInVideo(event: PointerEvent<HTMLDivElement>) {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return null;
    const box = video.getBoundingClientRect();
    const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
    const width = video.videoWidth * scale;
    const height = video.videoHeight * scale;
    const left = box.left + (box.width - width) / 2;
    const top = box.top + (box.height - height) / 2;
    return { x: clamp((event.clientX - left) / width), y: clamp((event.clientY - top) / height) };
  }
  function updateRoi(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    const point = pointInVideo(event);
    if (!drag || drag.pointerId !== event.pointerId || !point) return;
    const x = Math.min(drag.x, point.x);
    const y = Math.min(drag.y, point.y);
    setRoi({ x, y, width: Math.max(drag.x, point.x) - x, height: Math.max(drag.y, point.y) - y });
  }
  function previewSelection() {
    const video = videoRef.current;
    if (!video || !candidate.source) return;
    video.currentTime = startMs / 1000;
    setPlaybackMessage(null);
    previewingRef.current = true;
    void video.play().catch(() => {
      previewingRef.current = false;
      setPlaybackMessage("Preview could not start. Try the video playback button. You can still submit a confirmed selection.");
    });
  }

  return (
    <section aria-label="HomeCourt clip selection" className="flex flex-col gap-5">
      <label className="flex flex-col gap-2 text-sm">
        <span className="font-medium">HomeCourt exported video</span>
        <input type="file" accept="video/mp4,video/quicktime,video/webm" disabled={disabled}
          className="w-full min-w-0 text-[var(--muted)] file:mr-3 file:rounded-xl file:border file:border-[var(--border)] file:bg-[var(--surface)] file:px-4 file:py-3 file:font-semibold file:text-[var(--foreground)]"
          onChange={(event) => { const next = event.target.files?.[0] ?? null; event.target.value = ""; selectFile(next); }} />
        <span className="text-[var(--muted)]">MP4, MOV or WebM, up to 200 MB and 10 minutes. Select one complete shot from the original video.</span>
      </label>

      {previewUrl ? (
        <>
          <div className="relative w-full self-center overflow-hidden rounded-xl bg-black" style={{ aspectRatio, maxWidth: `${aspectRatio * 65}vh` }}>
            <video key={previewUrl} ref={videoRef} src={previewUrl} controls={!drawing} muted playsInline preload="metadata"
              aria-label="Original HomeCourt video preview" className="absolute inset-0 h-full w-full object-contain"
              onLoadedMetadata={(event) => {
                const video = event.currentTarget;
                if (video.getAttribute("src") !== urlRef.current) return;
                if (!Number.isFinite(video.duration) || video.duration <= 0) { setMessage("Could not determine the video duration. Try exporting an MP4 video."); return; }
                if (video.duration > MAX_HOMECOURT_SECONDS) { setMessage("The original video exceeds 10 minutes. Export a shorter practice video first."); return; }
                const duration = Math.round(video.duration * 1000);
                setDurationMs(duration);
                setAspectRatio(video.videoWidth / video.videoHeight || 16 / 9);
                setEndMs(Math.min(duration, 6000));
              }}
              onError={() => setMessage("This browser cannot read the video. Try MP4 or WebM.")}
              onTimeUpdate={(event) => {
                const video = event.currentTarget;
                if ((loop || previewingRef.current) && candidate.source && !video.paused && video.currentTime * 1000 >= endMs) {
                  if (loop) video.currentTime = startMs / 1000;
                  else { video.pause(); video.currentTime = endMs / 1000; previewingRef.current = false; }
                }
              }}
              onSeeking={(event) => {
                const ms = event.currentTarget.currentTime * 1000;
                if (ms < startMs || ms > endMs) previewingRef.current = false;
              }}
              onEnded={(event) => {
                if (loop && candidate.source) { event.currentTarget.currentTime = startMs / 1000; void event.currentTarget.play().catch(() => undefined); }
                else previewingRef.current = false;
              }} />
            {roi ? <div aria-label="Selected person region" className="pointer-events-none absolute border-2 border-[var(--accent)] bg-[var(--accent)]/10"
              style={{ left: `${roi.x * 100}%`, top: `${roi.y * 100}%`, width: `${roi.width * 100}%`, height: `${roi.height * 100}%` }} /> : null}
            {drawing ? <div role="img" aria-label="Drag a rectangle to select yourself" className="absolute inset-0 cursor-crosshair touch-none"
              onPointerDown={(event) => {
                if (disabled) return;
                const point = pointInVideo(event);
                if (!point) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                dragRef.current = { pointerId: event.pointerId, ...point };
                setRoi(undefined);
                setConfirmed(false);
              }} onPointerMove={updateRoi}
              onPointerUp={(event) => {
                if (dragRef.current?.pointerId !== event.pointerId) return;
                updateRoi(event);
                dragRef.current = null;
                setDrawing(false);
              }} onPointerCancel={() => { dragRef.current = null; setRoi(undefined); setDrawing(false); setConfirmed(false); }} /> : null}
          </div>
          <p className="break-words text-sm text-[var(--muted)] [overflow-wrap:anywhere]">{file?.name}{durationMs !== null ? ` · Original: ${(durationMs / 1000).toFixed(1)} seconds` : " · Reading video duration…"}</p>

          {durationMs !== null ? (
            <fieldset disabled={disabled} className="flex flex-col gap-5 disabled:opacity-60">
              <legend className="mb-2 font-medium">Select one shot</legend>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="flex flex-col gap-2 text-sm">Start time (seconds)
                  <input type="number" aria-label="Start time (seconds)" min={0} max={durationMs / 1000} step={0.1} value={startMs / 1000}
                    onChange={(event) => { setStartMs(Math.round(Number(event.target.value) * 1000)); setConfirmed(false); }} className={inputClass} />
                  <input type="range" aria-label="Shot start position" min={0} max={durationMs} step={100} value={startMs}
                    onChange={(event) => { setStartMs(Number(event.target.value)); setConfirmed(false); }} />
                  <button type="button" onClick={() => { setStartMs(Math.round((videoRef.current?.currentTime ?? 0) * 1000)); setConfirmed(false); }} className={buttonClass}>Start at the current frame</button>
                </label>
                <label className="flex flex-col gap-2 text-sm">End time (seconds)
                  <input type="number" aria-label="End time (seconds)" min={0} max={durationMs / 1000} step={0.1} value={endMs / 1000}
                    onChange={(event) => { setEndMs(Math.round(Number(event.target.value) * 1000)); setConfirmed(false); }} className={inputClass} />
                  <input type="range" aria-label="Shot end position" min={0} max={durationMs} step={100} value={endMs}
                    onChange={(event) => { setEndMs(Number(event.target.value)); setConfirmed(false); }} />
                  <button type="button" onClick={() => { setEndMs(Math.round((videoRef.current?.currentTime ?? 0) * 1000)); setConfirmed(false); }} className={buttonClass}>End at the current frame</button>
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-4 text-sm">
                <button type="button" disabled={!candidate.source || drawing} onClick={previewSelection} className={buttonClass}>Preview selection</button>
                <label className="flex items-center gap-2"><input type="checkbox" checked={loop} onChange={(event) => setLoop(event.target.checked)} />Loop selection</label>
                <span className="tabular-nums">Selected: {Math.max(0, (endMs - startMs) / 1000).toFixed(1)} seconds / {MAX_SHOT_MS / 1000} seconds maximum</span>
              </div>
              <p className="text-sm text-[var(--muted)]">Start before the dip and include the follow-through after release. The service extracts this interval and deletes its temporary original after processing.</p>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="flex flex-col gap-2 text-sm">Playback speed
                  <select aria-label="Playback speed" value={timingMode} onChange={(event) => setTimingMode(event.target.value as TimingMode)} className={inputClass}>
                    <option value="unknown">Unknown (default)</option><option value="realtime">Confirmed real time</option><option value="slow_motion">Slow motion</option>
                  </select>
                </label>
                <label className="flex flex-col gap-2 text-sm">Practice time (optional)
                  <input type="datetime-local" value={recordedAt} onChange={(event) => setRecordedAt(event.target.value)} className={inputClass} />
                </label>
                <label className="flex flex-col gap-2 text-sm sm:col-span-2">Camera label (optional)
                  <input value={cameraLabel} maxLength={80} onChange={(event) => setCameraLabel(event.target.value)} placeholder="For example: fixed camera, right side of half court" className={inputClass} />
                </label>
              </div>
              <p className="text-sm text-[var(--muted)]">Timing requires confirmed real-time playback for both this video and the reference. Oblique views, distant shots and hidden joints limit measurements. Use the same camera position when comparing your own shots.</p>

              <label className="flex flex-col gap-2 text-sm">People in this shot?
                <select value={multiplePeople ? "multiple" : "single"} onChange={(event) => {
                  setMultiplePeople(event.target.value === "multiple"); setConfirmed(false); setRoi(undefined); setDrawing(false); dragRef.current = null;
                }} className={inputClass}>
                  <option value="single">Only me</option><option value="multiple">Other people are visible; select me</option>
                </select>
              </label>
              {multiplePeople ? <div className="flex flex-col items-start gap-2 text-sm">
                <p>Pause on a frame where you are clearly visible, then draw a rectangle around your full body. The region selects the shooter; the full video frame is preserved.</p>
                <button type="button" onClick={() => { videoRef.current?.pause(); setDrawing(!drawing); setConfirmed(false); }} className={buttonClass}>
                  {drawing ? "Cancel selection" : roi ? "Redraw person region" : "Draw person region"}
                </button>
                {drawing ? <p role="status">Drag on the video above to select your full body.</p> : null}
                {!drawing && roi && (roi.width < 0.03 || roi.height < 0.03) ? <p role="status">The region is too small. Draw a new rectangle around your full body.</p> : null}
              </div> : null}
              <label className="flex items-start gap-3 text-sm">
                <input type="checkbox" className="mt-1" checked={confirmed}
                  disabled={multiplePeople && (!roi || roi.width < 0.03 || roi.height < 0.03 || drawing)}
                  onChange={(event) => setConfirmed(event.target.checked)} />
                <span>{multiplePeople ? "I confirm the rectangle selects me and the selection contains one complete shot." : "I confirm I am the only person in the selection and it contains one complete shot."}</span>
              </label>
            </fieldset>
          ) : null}
        </>
      ) : null}
      {message || candidate.error ? <p role="alert" className="text-sm text-[var(--accent)]">{message ?? candidate.error}</p> : null}
      {playbackMessage ? <p role="status" className="text-sm text-[var(--muted)]">{playbackMessage}</p> : null}
    </section>
  );
}
