"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAnalysis } from "@/lib/use-analysis";
import { validateClipFile } from "@/lib/clip";
import CaptureGuide from "../capture-guide";
import AnalysisEntryNav from "../components/analysis-entry-nav";

export default function UploadPage() {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const previewRef = useRef<string | null>(null);
  const { analyze, submitting, message, setMessage } = useAnalysis();
  useEffect(() => () => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
  }, []);

  return (
    <div className="page-shell page-shell-narrow flex flex-1 flex-col gap-6">
      <header><p className="eyebrow">Analyze / Upload</p><h1 className="page-title mt-2">Upload a shot clip</h1></header>
      <AnalysisEntryNav />
      <p className="page-description">
        mp4 / mov / webm, up to 50&nbsp;MB and 12 seconds, one shot per clip.
        Compare form against the Curry v3 footage; timing comparison requires verified real-time playback.
      </p>
      <Link href="/homecourt" className="text-sm text-[var(--accent)] underline underline-offset-4">Using a HomeCourt training video? Select a shot from your session.</Link>

      <CaptureGuide />

      <input
        type="file"
        aria-label="Shot clip"
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
        className="field-input w-full file:mr-3 file:rounded-lg file:border-0 file:bg-[var(--accent-soft)] file:px-3 file:py-2 file:text-[var(--accent)]"
      />

      {previewUrl ? (
        <video
          src={previewUrl}
          controls
          muted
          playsInline
          className="aspect-video w-full rounded-2xl bg-black object-contain"
        />
      ) : null}

      <button
        onClick={() => file && void analyze(file)}
        disabled={!file || submitting}
        className="button-primary self-start"
      >
        {submitting ? "Analyzing…" : "Analyze my shot"}
      </button>

      {message ? (
        <p role="status" className="text-sm text-[var(--muted)]">
          {message}
        </p>
      ) : null}
    </div>
  );
}
