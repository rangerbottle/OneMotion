"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { submitAnalysis } from "@/lib/api";
import CaptureGuide from "../capture-guide";

type CameraState = "idle" | "on" | "recording" | "recorded" | "error";

export default function RecordPage() {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const [state, setState] = useState<CameraState>("idle");
  const [clip, setClip] = useState<Blob | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Always release the camera when leaving the page.
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function startCamera() {
    setMessage(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setState("on");
    } catch {
      setState("error");
      setMessage("Camera unavailable. Check permissions, or upload a clip instead.");
    }
  }

  function startRecording() {
    const stream = streamRef.current;
    if (!stream) return;
    chunksRef.current = [];
    const recorder = new MediaRecorder(stream);
    recorderRef.current = recorder;
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      setClip(new Blob(chunksRef.current, { type: recorder.mimeType }));
      setState("recorded");
    };
    recorder.start();
    setState("recording");
    // One rep = max 10 s (PRD FR-2.1).
    setTimeout(() => recorder.state === "recording" && recorder.stop(), 10_000);
  }

  function stopRecording() {
    recorderRef.current?.stop();
  }

  async function analyze() {
    if (!clip) return;
    setSubmitting(true);
    setMessage("Analyzing… pose estimation takes ~30 s for a 10 s clip.");
    try {
      const resp = await submitAnalysis(
        new File([clip], "shot.webm", { type: clip.type }),
      );
      if (resp.ok) {
        const result = await resp.json();
        router.push(`/analysis/${result.analysis_id}`);
        return;
      }
      const body = await resp.json().catch(() => null);
      setMessage(body?.detail ?? body?.error?.message ?? `analysis failed (${resp.status})`);
    } catch {
      setMessage("Could not reach the analysis service. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col items-center gap-6 px-6 py-10">
      <h1 className="text-2xl font-semibold">Record your shot</h1>
      <p className="max-w-md text-center text-zinc-600 dark:text-zinc-400">
        Every comparison uses the Curry v3 real-time reference. Record one shot,
        max 10 seconds.
      </p>

      <CaptureGuide />

      <video
        ref={videoRef}
        playsInline
        muted
        className="aspect-video w-full max-w-2xl rounded-xl bg-black"
      />

      <div className="flex gap-4">
        {state === "idle" || state === "error" ? (
          <button
            onClick={startCamera}
            className="h-12 rounded-full bg-foreground px-8 text-background"
          >
            Enable camera
          </button>
        ) : null}
        {state === "on" || state === "recorded" ? (
          <button
            onClick={startRecording}
            className="h-12 rounded-full bg-red-600 px-8 text-white"
          >
            Record
          </button>
        ) : null}
        {state === "recording" ? (
          <button
            onClick={stopRecording}
            className="h-12 rounded-full border px-8"
          >
            Stop
          </button>
        ) : null}
        {state === "recorded" ? (
          <button
            onClick={analyze}
            disabled={submitting}
            className="h-12 rounded-full bg-foreground px-8 text-background"
          >
            {submitting ? "Analyzing…" : "Analyze my shot"}
          </button>
        ) : null}
      </div>

      {message ? (
        <p className="max-w-md text-center text-sm text-zinc-600 dark:text-zinc-400">
          {message}
        </p>
      ) : null}

      <p className="text-sm text-zinc-500">
        No camera? <Link href="/upload" className="underline">Upload a clip</Link> instead.
      </p>
    </div>
  );
}
