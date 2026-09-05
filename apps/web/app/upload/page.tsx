"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { submitAnalysis } from "@/lib/api";
import CaptureGuide from "../capture-guide";

export default function UploadPage() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const previewUrl = useMemo(() => file ? URL.createObjectURL(file) : null, [file]);
  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  async function analyze() {
    if (!file) return;
    setSubmitting(true);
    setMessage("Analyzing… pose estimation takes ~30 s for a 10 s clip.");
    try {
      const resp = await submitAnalysis(file);
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
      <h1 className="text-2xl font-semibold">Upload a shot clip</h1>
      <p className="max-w-md text-center text-zinc-600 dark:text-zinc-400">
        mp4 / mov / webm, up to 50&nbsp;MB and 12 seconds, one shot per clip.
        Every comparison uses the Curry v3 real-time reference.
      </p>

      <CaptureGuide />

      <input
        type="file"
        accept="video/mp4,video/quicktime,video/webm"
        onChange={(e) => {
          setFile(e.target.files?.[0] ?? null);
          setMessage(null);
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
        onClick={analyze}
        disabled={!file || submitting}
        className="h-12 rounded-full bg-foreground px-8 text-background disabled:opacity-40"
      >
        {submitting ? "Analyzing…" : "Analyze my shot"}
      </button>

      {message ? (
        <p className="max-w-md text-center text-sm text-zinc-600 dark:text-zinc-400">
          {message}
        </p>
      ) : null}
    </div>
  );
}
