"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useAnalysis } from "@/lib/use-analysis";
import { MAX_CLIP_SECONDS, recordingFilename } from "@/lib/clip";
import CaptureGuide from "../capture-guide";
import AnalysisEntryNav from "../components/analysis-entry-nav";

type CameraState = "idle" | "requesting" | "on" | "recording" | "recorded" | "error";

export default function RecordPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const previewRef = useRef<string | null>(null);

  const [state, setState] = useState<CameraState>("idle");
  const [clip, setClip] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const { analyze, submitting, message, setMessage } = useAnalysis();
  const mounted = useRef(false);
  const requesting = useRef(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      const recorder = recorderRef.current;
      if (recorder) {
        recorder.onstop = null;
        recorder.ondataavailable = null;
        recorder.onerror = null;
        if (recorder.state !== "inactive") recorder.stop();
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
      previewRef.current = null;
    };
  }, []);

  async function startCamera() {
    if (requesting.current || submitting) return;
    requesting.current = true;
    setState("requesting");
    setMessage(null);
    let acquired: MediaStream | null = null;
    try {
      acquired = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      if (!mounted.current) {
        acquired.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = acquired;
      if (videoRef.current) {
        videoRef.current.srcObject = acquired;
        await videoRef.current.play();
      }
      if (mounted.current) setState("on");
    } catch {
      acquired?.getTracks().forEach((track) => track.stop());
      if (mounted.current) {
        setState("error");
        setMessage("Camera unavailable. Check permissions, or upload a clip instead.");
      }
    } finally {
      requesting.current = false;
    }
  }

  function startRecording() {
    const stream = streamRef.current;
    if (!stream || submitting || recorderRef.current?.state === "recording") return;
    setClip(null);
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = null;
    setPreviewUrl(null);
    setMessage(null);
    chunksRef.current = [];
    try {
      if (videoRef.current) {
        videoRef.current.pause();
        videoRef.current.removeAttribute("src");
        videoRef.current.srcObject = stream;
        void videoRef.current.play().catch(() => undefined);
      }
      const mimeType = ["video/webm;codecs=vp8", "video/mp4", "video/webm"].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (mounted.current && event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        if (!mounted.current) return;
        const recorded = new Blob(chunksRef.current, { type: recorder.mimeType });
        if (!recorded.size) {
          setState("on");
          setMessage("The recording is empty. Record another shot before analyzing.");
          return;
        }
        const url = URL.createObjectURL(recorded);
        previewRef.current = url;
        if (videoRef.current) {
          videoRef.current.pause();
          videoRef.current.srcObject = null;
        }
        setPreviewUrl(url);
        setClip(recorded);
        setState("recorded");
      };
      recorder.onerror = () => {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        recorder.onstop = null;
        if (recorder.state !== "inactive") recorder.stop();
        if (mounted.current) {
          setState("on");
          setMessage("Recording failed. Please try again or upload a clip.");
        }
      };
      recorder.start();
      setState("recording");
      timeoutRef.current = setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
      }, MAX_CLIP_SECONDS * 1000 - 250); // Leave room for the final encoded frame.
    } catch {
      setState("on");
      setMessage("Video recording is unavailable. Try uploading a clip instead.");
    }
  }

  function stopRecording() {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }

  return (
    <div className="page-shell page-shell-narrow flex flex-1 flex-col gap-6">
      <header><p className="eyebrow">Analyze / Record</p><h1 className="page-title mt-2">Record your shot</h1></header>
      <AnalysisEntryNav />
      <p className="page-description">
        Record one complete shot, max 12 seconds, for the Curry v3 comparison.
        Timing comparison requires verified playback speed.
      </p>

      <CaptureGuide />

      <video
        ref={videoRef}
        src={previewUrl ?? undefined}
        controls={state === "recorded"}
        playsInline
        muted
        className="aspect-video w-full rounded-2xl bg-black"
      />
      {state === "recorded" ? (
        <p className="text-sm text-[var(--muted)]">
          Review your recording before analyzing. Select Record to replace it with a new shot.
        </p>
      ) : null}

      <div className="flex flex-wrap gap-3">
        {state === "idle" || state === "error" || state === "requesting" ? (
          <button
            onClick={startCamera}
            disabled={state === "requesting" || submitting}
            className="button-primary"
          >
            {state === "requesting" ? "Waiting for camera…" : "Enable camera"}
          </button>
        ) : null}
        {state === "on" || state === "recorded" ? (
          <button
            onClick={startRecording}
            disabled={submitting}
            className="button-primary"
          >
            Record
          </button>
        ) : null}
        {state === "recording" ? (
          <button
            onClick={stopRecording}
            className="button-secondary"
          >
            Stop
          </button>
        ) : null}
        {state === "recorded" ? (
          <button
            onClick={() => clip && void analyze(new File([clip], recordingFilename(clip.type), { type: clip.type }))}
            disabled={submitting}
            className="button-primary"
          >
            {submitting ? "Analyzing…" : "Analyze my shot"}
          </button>
        ) : null}
      </div>

      {message ? (
        <p role="status" className="text-sm text-[var(--muted)]">
          {message}
        </p>
      ) : null}

      <p className="text-sm text-[var(--muted)]">
        No camera? <Link href="/upload" className="underline">Upload a clip</Link> instead.
      </p>
      <Link href="/homecourt" className="text-sm text-[var(--accent)] underline underline-offset-4">Import a HomeCourt training video</Link>
    </div>
  );
}
