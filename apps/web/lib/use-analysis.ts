"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { responseError, submitAnalysis } from "./api";
import { validateClip } from "./clip";

export function useAnalysis() {
  const router = useRouter();
  const pending = useRef<AbortController | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => () => pending.current?.abort(), []);

  async function analyze(file: File) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setSubmitting(true);
    setMessage("Checking your clip…");
    try {
      await validateClip(file, controller.signal);
      setMessage("Analyzing your shot… This can take up to two minutes.");
      const response = await submitAnalysis(file, controller.signal);
      if (!response.ok) throw await responseError(response);
      const result = await response.json();
      if (!controller.signal.aborted) router.push(`/analysis/${result.analysis_id}`);
    } catch (error) {
      if (!controller.signal.aborted) setMessage(error instanceof TypeError ? "Could not reach the analysis service. Please try again." : error instanceof Error ? error.message : "Analysis failed. Please try again.");
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setSubmitting(false);
    }
  }
  return { analyze, submitting, message, setMessage };
}
