"use client";

import { useEffect, useRef, useState } from "react";
import { useAnalysis } from "@/lib/use-analysis";
import { validateClipFile } from "@/lib/clip";
import CaptureGuide from "../capture-guide";

export default function UploadPage() {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const previewRef = useRef<string | null>(null);
  const { analyze, submitting, message, setMessage } = useAnalysis();
  useEffect(() => () => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
  }, []);

  return (
    <div className="flex flex-1 flex-col items-center gap-6 px-6 py-10">
      <h1 className="text-2xl font-semibold">Upload a shot clip</h1>
      <p className="max-w-md text-center text-zinc-600 dark:text-zinc-400">
        mp4 / mov / webm, up to 50&nbsp;MB and 12 seconds, one shot per clip.
        Every comparison uses the Curry v3 real-time reference.
      </p>

      <CaptureGuide />

      <input
        type="file"
        disabled={submitting}
        accept="video/mp4,video/quicktime,video/webm"
        onChange={(e) => {
          if (submitting) return;
          const selected = e.target.files?.[0] ?? null;
          setMessage(null);
          if (previewRef.current) URL.revokeObjectURL(previewRef.current);
          previewRef.current = null;
          setPreviewUrl(null);
          setFile(null);
          if (!selected) return;
          try {
            validateClipFile(selected);
            setFile(selected);
            previewRef.current = URL.createObjectURL(selected);
            setPreviewUrl(previewRef.current);
          } catch (error) {
            setMessage(error instanceof Error ? error.message : "Invalid clip.");
          }
        }}
        className="text-sm"
      />

      {previewUrl ? (
        <video
          src={previewUrl}
          controls
          muted
          playsInline
          className="aspect-video w-full max-w-2xl rounded-xl bg-black object-contain"
        />
      ) : null}

      <button
        onClick={() => file && void analyze(file)}
        disabled={!file || submitting}
        className="h-12 rounded-full bg-foreground px-8 text-background disabled:opacity-40"
      >
        {submitting ? "Analyzing…" : "Analyze my shot"}
      </button>

      {message ? (
        <p role="status" className="max-w-md text-center text-sm text-zinc-600 dark:text-zinc-400">
          {message}
        </p>
      ) : null}
    </div>
  );
}
