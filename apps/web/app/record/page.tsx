"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useAnalysis } from "@/lib/use-analysis";
import { MAX_CLIP_SECONDS, recordingFilename } from "@/lib/clip";
import CaptureGuide from "../capture-guide";

type CameraState = "idle" | "requesting" | "on" | "recording" | "recorded" | "error";

export default function RecordPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const [state, setState] = useState<CameraState>("idle");
  const [clip, setClip] = useState<Blob | null>(null);
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
    setMessage(null);
    chunksRef.current = [];
    try {
      const mimeType = ["video/webm;codecs=vp8", "video/mp4", "video/webm"].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (mounted.current && event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        if (!mounted.current) return;
        setClip(new Blob(chunksRef.current, { type: recorder.mimeType }));
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
      setMessage("Video recording is unavailable. Try uploading a clip instead.");
    }
  }

  function stopRecording() {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }

  return (
    <div className="flex flex-1 flex-col items-center gap-6 px-6 py-10">
      <h1 className="text-2xl font-semibold">Record your shot</h1>
      <p className="max-w-md text-center text-zinc-600 dark:text-zinc-400">
        Every comparison uses the Curry v3 real-time reference. Record one shot,
        max 12 seconds.
      </p>

      <CaptureGuide />

      <video
        ref={videoRef}
        playsInline
        muted
        className="aspect-video w-full max-w-2xl rounded-xl bg-black"
      />

      <div className="flex gap-4">
        {state === "idle" || state === "error" || state === "requesting" ? (
          <button
            onClick={startCamera}
            disabled={state === "requesting" || submitting}
            className="h-12 rounded-full bg-foreground px-8 text-background"
          >
            {state === "requesting" ? "Waiting for camera…" : "Enable camera"}
          </button>
        ) : null}
        {state === "on" || state === "recorded" ? (
          <button
            onClick={startRecording}
            disabled={submitting}
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
            onClick={() => clip && void analyze(new File([clip], recordingFilename(clip.type), { type: clip.type }))}
            disabled={submitting}
            className="h-12 rounded-full bg-foreground px-8 text-background"
          >
            {submitting ? "Analyzing…" : "Analyze my shot"}
          </button>
        ) : null}
      </div>

      {message ? (
        <p role="status" className="max-w-md text-center text-sm text-zinc-600 dark:text-zinc-400">
          {message}
        </p>
      ) : null}

      <p className="text-sm text-zinc-500">
        No camera? <Link href="/upload" className="underline">Upload a clip</Link> instead.
      </p>
    </div>
  );
}
