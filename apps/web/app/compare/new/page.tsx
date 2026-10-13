"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { responseError, type HomeCourtSourceInput } from "@/lib/api";
import { validateClipFile } from "@/lib/clip";
import { validateHomeCourtImport } from "@/lib/homecourt";
import HomeCourtClipSelector, { type HomeCourtSelection } from "@/app/homecourt/clip-selector";
import {
  createComparison,
  createPlayer,
  createTemplate,
  getPlayer,
  listPlayers,
  patchComparison,
  uploadClip,
  type ActionTemplate,
  type CameraCheckResult,
  type ClipKind,
  type ClipMeta,
  type ComparisonState,
  type Player,
  type PlayerDetail,
} from "@/lib/compare-api";

const CAMERA_TEXT: Record<CameraCheckResult["status"], string> = {
  match: "✅ Camera matched",
  suspect: "⚠️ Camera may have moved; results may be less reliable",
  mismatch: "❌ Camera positions do not match",
};

/** Side-view court + camera placement guidance, shared by both capture steps. */
function CameraGuide() {
  return (
    <div className="rounded-2xl border border-[var(--border)] p-5">
      <div className="flex flex-wrap items-center gap-6">
        <svg viewBox="0 0 320 180" className="w-full max-w-xs" role="img" aria-label="Camera setup diagram">
          {/* court floor */}
          <rect x="20" y="140" width="280" height="8" rx="2" className="fill-[var(--muted)]" />
          {/* hoop */}
          <line x1="260" y1="60" x2="260" y2="140" stroke="currentColor" strokeWidth="3" />
          <rect x="246" y="52" width="28" height="10" rx="2" className="fill-[var(--muted)]" />
          {/* player */}
          <circle cx="150" cy="72" r="8" className="fill-[var(--muted)]" />
          <line x1="150" y1="80" x2="150" y2="118" stroke="currentColor" strokeWidth="3" />
          <line x1="150" y1="92" x2="132" y2="104" stroke="currentColor" strokeWidth="3" />
          <line x1="150" y1="92" x2="172" y2="84" stroke="currentColor" strokeWidth="3" />
          <line x1="150" y1="118" x2="140" y2="140" stroke="currentColor" strokeWidth="3" />
          <line x1="150" y1="118" x2="162" y2="140" stroke="currentColor" strokeWidth="3" />
          {/* camera */}
          <rect x="18" y="96" width="22" height="16" rx="3" className="fill-foreground" />
          <polygon points="40,100 52,94 52,114 40,108" className="fill-foreground" />
          {/* distance annotation 3-5m */}
          <line x1="46" y1="158" x2="150" y2="158" stroke="currentColor" strokeWidth="1" strokeDasharray="4 3" />
          <text x="86" y="172" fontSize="11" className="fill-[var(--muted)]">3–5 m</text>
          {/* height annotation 1.2-1.5m */}
          <line x1="8" y1="96" x2="8" y2="140" stroke="currentColor" strokeWidth="1" strokeDasharray="4 3" />
          <text x="12" y="122" fontSize="11" className="fill-[var(--muted)]">1.2–1.5 m</text>
        </svg>
        <ul className="flex-1 space-y-1 text-sm text-[var(--muted)]">
          <li>Record from a 90° side view, with the whole body visible.</li>
          <li>Keep the phone fixed at a height of 1.2–1.5 m, about 3–5 m from the player.</li>
          <li>Use portrait or landscape, keeping the same orientation for both clips.</li>
        </ul>
      </div>
    </div>
  );
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function NewComparisonPage() {
  return (
    <Suspense
      fallback={
        <div className="page-shell page-shell-narrow flex flex-1 items-center justify-center">
          <p role="status" className="text-[var(--muted)]">Loading…</p>
        </div>
      }
    >
      <Wizard />
    </Suspense>
  );
}

function Wizard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const playerParam = searchParams.get("player");
  const templateParam = searchParams.get("template");
  const homeCourt = searchParams.get("source") === "homecourt";

  const [players, setPlayers] = useState<Player[] | null>(null);
  const [detail, setDetail] = useState<PlayerDetail | null>(null);
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(playerParam);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(templateParam);
  const [step, setStep] = useState<"setup" | "baseline" | "comparison" | "align">(
    playerParam ? "baseline" : "setup",
  );
  const [message, setMessage] = useState<string | null>(null);

  const [baselineClip, setBaselineClip] = useState<ClipMeta | null>(null);
  const [comparisonClip, setComparisonClip] = useState<ClipMeta | null>(null);

  const [comparison, setComparison] = useState<ComparisonState | null>(null);
  const [comparing, setComparing] = useState(false);
  const [compareFailed, setCompareFailed] = useState(false);
  const [offsetA, setOffsetA] = useState(0);
  const [offsetB, setOffsetB] = useState(0);
  const [allowMismatch, setAllowMismatch] = useState(false);
  const creatingRef = useRef<number | null>(null);
  const runRef = useRef(0);
  const selectedPlayerRef = useRef<string | null>(playerParam);
  const detailRunRef = useRef(0);
  const alignSavingRef = useRef(false);
  const [alignSaving, setAlignSaving] = useState(false);
  const personalSetupRef = useRef(false);
  const [settingUpPersonal, setSettingUpPersonal] = useState(false);

  const loadDetail = useCallback(async (playerId: string) => {
    const run = ++detailRunRef.current;
    const data = await getPlayer(playerId);
    if (run !== detailRunRef.current || selectedPlayerRef.current !== playerId) return null;
    setDetail(data);
    return data;
  }, []);
  useEffect(() => () => { runRef.current += 1; detailRunRef.current += 1; }, []);

  function invalidateComparison() {
    runRef.current += 1;
    creatingRef.current = null;
    setComparison(null);
    setComparing(false);
    setCompareFailed(false);
    setAllowMismatch(false);
  }

  function clearPair() {
    invalidateComparison();
    setBaselineClip(null);
    setComparisonClip(null);
  }

  useEffect(() => {
    if (playerParam) {
      // Fetch-on-mount: loadDetail() sets state only after awaited network calls.
      void loadDetail(playerParam)
        .then((data) => {
          // ?player= without ?template=: pick the first template so the clip
          // lists are not permanently empty for fresh players.
          if (!templateParam && data?.templates[0]) {
            setSelectedTemplateId(data.templates[0].template_id);
          }
        })
        .catch((error) => {
          if (selectedPlayerRef.current === playerParam) setMessage(error instanceof Error ? error.message : "Could not load player details.");
        });
      return;
    }
    listPlayers()
      .then(setPlayers)
      .catch((error) => {
        setPlayers([]);
        setMessage(error instanceof Error ? error.message : "Could not load players.");
      });
  }, [playerParam, templateParam, loadDetail]);

  async function handlePickPlayer(playerId: string) {
    selectedPlayerRef.current = playerId || null;
    setSelectedPlayerId(playerId || null);
    clearPair();
    setSelectedTemplateId(null);
    setDetail(null);
    setMessage(null);
    if (!playerId) { detailRunRef.current += 1; return; }
    try {
      const data = await loadDetail(playerId);
      if (data?.templates[0]) setSelectedTemplateId(data.templates[0].template_id);
    } catch (error) {
      if (selectedPlayerRef.current === playerId) setMessage(error instanceof Error ? error.message : "Could not load player details.");
    }
  }

  async function handleStart() {
    if (!selectedPlayerId || !selectedTemplateId) {
      setMessage("Choose a player and an action template first.");
      return;
    }
    setMessage(null);
    setStep("baseline");
  }

  async function handlePersonalSetup() {
    if (!players || personalSetupRef.current) return;
    personalSetupRef.current = true;
    setSettingUpPersonal(true);
    clearPair();
    detailRunRef.current += 1;
    setMessage(null);
    try {
      // Reuse legacy personal profiles without renaming stored user data.
      const player = players.find((item) => ["Me", "\u6211"].includes(item.name)) ?? await createPlayer("Me");
      selectedPlayerRef.current = player.player_id;
      setPlayers((current) => current?.some((item) => item.player_id === player.player_id) ? current : [...(current ?? []), player]);
      const data = await getPlayer(player.player_id);
      const template = data.templates.find((item) => ["Jump shot", "\u8df3\u6295"].includes(item.name)) ??
        await createTemplate(player.player_id, "Jump shot", ["Preparation", "Load", "Release", "Follow-through"]);
      setSelectedPlayerId(player.player_id);
      setSelectedTemplateId(template.template_id);
      setDetail({ ...data, templates: data.templates.some((item) => item.template_id === template.template_id) ? data.templates : [...data.templates, template] });
      setStep("baseline");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not set up your jump-shot profile. Please try again.");
    } finally {
      personalSetupRef.current = false;
      setSettingUpPersonal(false);
    }
  }

  function clipSource(kind: ClipKind): ClipMeta[] {
    return (detail?.clips ?? []).filter(
      (clip) => clip.kind === kind && clip.template_id === selectedTemplateId,
    );
  }

  function handleClipPicked(clip: ClipMeta) {
    setMessage(null);
    // Any clip change invalidates a previous camera check / suggestion run —
    // the align step must re-run against the new pair.
    invalidateComparison();
    if (clip.kind === "baseline") setBaselineClip(clip);
    else setComparisonClip(clip);
  }

  async function handleClipUploaded(clip: ClipMeta) {
    handleClipPicked(clip);
    if (selectedPlayerId) {
      try {
        await loadDetail(selectedPlayerId);
      } catch {
        // Refresh is best-effort; the uploaded clip is already selected.
      }
    }
  }

  async function runComparison() {
    if (!selectedPlayerId || !selectedTemplateId || !baselineClip || !comparisonClip) return;
    if (creatingRef.current !== null) return; // double-click guard: never POST twice
    const run = ++runRef.current;
    creatingRef.current = run;
    setComparing(true);
    setCompareFailed(false);
    setAllowMismatch(false);
    setMessage(null);
    try {
      const state = await createComparison({
        playerId: selectedPlayerId,
        templateId: selectedTemplateId,
        baselineClipId: baselineClip.clip_id,
        comparisonClipId: comparisonClip.clip_id,
      });
      if (run !== runRef.current) return;
      setComparison(state);
      setOffsetA(state.temporal.offset_ms_a);
      setOffsetB(state.temporal.offset_ms_b);
    } catch (error) {
      if (run !== runRef.current) return;
      setCompareFailed(true);
      setMessage(error instanceof Error ? error.message : "Camera check failed. Please try again.");
    } finally {
      if (creatingRef.current === run) creatingRef.current = null;
      if (run === runRef.current) setComparing(false);
    }
  }

  function handleEnterAlign() {
    setStep("align");
    if (!comparison && !comparing) void runComparison();
  }

  const cameraStatus: CameraCheckResult["status"] | null =
    comparison?.camera_check?.status ?? null;
  const maxOffsetA = Math.max(0, Math.ceil(baselineClip?.duration_ms ?? 1) - 1);
  const maxOffsetB = Math.max(0, Math.ceil(comparisonClip?.duration_ms ?? 1) - 1);

  async function handleCreateWorkbench() {
    if (!comparison || alignSavingRef.current || comparing) return;
    if (![offsetA, offsetB].every(Number.isInteger) || offsetA < 0 || offsetA > maxOffsetA || offsetB < 0 || offsetB > maxOffsetB) {
      setMessage("Action starts must be whole milliseconds within each video duration.");
      return;
    }
    const run = runRef.current;
    alignSavingRef.current = true;
    setAlignSaving(true);
    setMessage(null);
    try {
      await patchComparison(comparison.comparison_id, { temporal: { offset_ms_a: offsetA, offset_ms_b: offsetB } });
      if (run === runRef.current) router.push(`/compare/${comparison.comparison_id}`);
    } catch (error) {
      if (run === runRef.current) setMessage(error instanceof Error ? error.message : "Could not save action starts. Please try again.");
    } finally {
      alignSavingRef.current = false;
      if (run === runRef.current) setAlignSaving(false);
    }
  }

  return (
    <div className="page-shell page-shell-narrow flex flex-1 flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="page-title">New movement comparison</h1>
        <Link href="/compare" className="text-sm text-[var(--muted)] hover:underline">Back to comparisons</Link>
      </div>
      {homeCourt ? <p className="text-sm text-[var(--muted)]">Select one shot from an earlier session and one from your latest session. Keep the same camera position. Clips with unknown speed or slow motion cannot support reliable timing comparisons.</p> : null}

      <ol className="flex flex-wrap gap-2 text-sm">
        {(playerParam ? ["Baseline movement", "Comparison movement", "Camera check and alignment"] : ["Choose player", "Baseline movement", "Comparison movement", "Camera check and alignment"]).map(
          (label, index) => {
            const stepOrder: Record<string, number> = playerParam
              ? { baseline: 0, comparison: 1, align: 2 }
              : { setup: 0, baseline: 1, comparison: 2, align: 3 };
            const current = stepOrder[step];
            return (
              <li
                key={label}
                className={`rounded-full px-3 py-1 ${index === current
                  ? "bg-[var(--accent)] text-[var(--surface)]"
                  : index < current
                    ? "bg-[var(--surface-muted)] text-[var(--muted)]"
                    : "border border-[var(--border)] text-[var(--muted)]"}`}
              >
                {label}
              </li>
            );
          },
        )}
      </ol>

      {message ? (
        <p role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/[.06] p-4 text-sm text-[var(--foreground)]">
          {message}
        </p>
      ) : null}

      {step === "setup" ? (
        <section className="flex flex-col gap-5 rounded-2xl border border-[var(--border)] p-6">
          <h2 className="text-lg font-semibold">Choose a player and an action template</h2>
          {homeCourt ? <button onClick={() => void handlePersonalSetup()} disabled={!players || settingUpPersonal}
            className="h-12 w-fit rounded-full border border-[var(--border)] px-6 disabled:opacity-40">
            {settingUpPersonal ? "Setting up your profile…" : "Use my jump-shot profile (Me / Jump shot)"}
          </button> : null}
          {!players ? (
            <p role="status" className="text-sm text-[var(--muted)]">Loading players…</p>
          ) : (
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-[var(--muted)]">Player</span>
              <select
                disabled={settingUpPersonal}
                value={selectedPlayerId ?? ""}
                onChange={(e) => void handlePickPlayer(e.target.value)}
                className="h-10 rounded-xl border border-[var(--border)] bg-transparent px-3"
              >
                <option value="">Choose a player</option>
                {players.map((player) => (
                  <option key={player.player_id} value={player.player_id}>{player.name}</option>
                ))}
              </select>
            </label>
          )}
          {selectedPlayerId ? (
            !detail ? (
              <p role="status" className="text-sm text-[var(--muted)]">Loading templates…</p>
            ) : (
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-[var(--muted)]">Action template</span>
                <select
                  disabled={settingUpPersonal}
                  value={selectedTemplateId ?? ""}
                  onChange={(e) => { clearPair(); setSelectedTemplateId(e.target.value || null); }}
                  className="h-10 rounded-xl border border-[var(--border)] bg-transparent px-3"
                >
                  <option value="">Choose a template</option>
                  {detail.templates.map((template: ActionTemplate) => (
                    <option key={template.template_id} value={template.template_id}>
                      {template.name}
                    </option>
                  ))}
                </select>
              </label>
            )
          ) : null}
          {detail && detail.templates.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">
              This player has no action templates. Create one on the comparisons page first.
            </p>
          ) : null}
          <button
            onClick={() => void handleStart()}
            disabled={!selectedPlayerId || !selectedTemplateId || settingUpPersonal}
            className="h-12 w-fit rounded-full bg-[var(--accent)] px-8 text-[var(--surface)] disabled:opacity-40"
          >
            Next
          </button>
        </section>
      ) : null}

      {step === "baseline" ? (
        <ClipPickStep
          key="baseline"
          homeCourt={homeCourt}
          title="Baseline movement (earlier session)"
          subtitle="Choose or upload a previously recorded baseline clip."
          kind="baseline"
          clips={clipSource("baseline")}
          templateId={selectedTemplateId}
          playerId={selectedPlayerId}
          selected={baselineClip}
          onPicked={handleClipPicked}
          onUploaded={handleClipUploaded}
          onMessage={setMessage}
        >
          <button
            onClick={() => setStep(playerParam ? "baseline" : "setup")}
            className="h-12 rounded-full border border-[var(--border)] px-8"
          >
            Back
          </button>
          <button
            onClick={() => setStep("comparison")}
            disabled={!baselineClip}
            className="h-12 rounded-full bg-[var(--accent)] px-8 text-[var(--surface)] disabled:opacity-40"
          >
            Next
          </button>
        </ClipPickStep>
      ) : null}

      {step === "comparison" ? (
        <ClipPickStep
          key="comparison"
          homeCourt={homeCourt}
          title="Comparison movement (latest session)"
          subtitle="Choose or upload a clip from your latest practice."
          kind="comparison"
          clips={clipSource("comparison")}
          templateId={selectedTemplateId}
          playerId={selectedPlayerId}
          selected={comparisonClip}
          onPicked={handleClipPicked}
          onUploaded={handleClipUploaded}
          onMessage={setMessage}
        >
          <button
            onClick={() => setStep("baseline")}
            className="h-12 rounded-full border border-[var(--border)] px-8"
          >
            Back
          </button>
          <button
            onClick={handleEnterAlign}
            disabled={!comparisonClip}
            className="h-12 rounded-full bg-[var(--accent)] px-8 text-[var(--surface)] disabled:opacity-40"
          >
            Next
          </button>
        </ClipPickStep>
      ) : null}

      {step === "align" ? (
        <section className="flex flex-col gap-5 rounded-2xl border border-[var(--border)] p-6">
          <h2 className="text-lg font-semibold">Camera check and alignment</h2>

          {comparing ? (
            <p role="status" className="text-sm text-[var(--muted)]">
              Checking the camera and alignment… This may take a few seconds.
            </p>
          ) : compareFailed ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-[var(--muted)]">Camera check is incomplete.</p>
              <button
                onClick={() => void runComparison()}
                className="h-9 rounded-full border border-[var(--border)] px-5 text-sm"
              >
                Retry camera check
              </button>
            </div>
          ) : comparison ? (
            <>
              <div className={`rounded-xl border p-4 text-sm ${
                cameraStatus === "match"
                  ? "border-emerald-500/30 bg-emerald-500/[.06]"
                  : cameraStatus === "suspect"
                    ? "border-amber-500/30 bg-amber-500/[.06]"
                    : "border-red-500/30 bg-red-500/[.06]"
              }`}
              >
                <p className="font-medium">
                  {cameraStatus ? CAMERA_TEXT[cameraStatus] : "No camera information available"}
                  {comparison.camera_check
                    ? ` (matched features ${comparison.camera_check.matches}, inlier ratio ${(comparison.camera_check.inlier_ratio * 100).toFixed(0)}%)`
                    : ""}
                </p>
                {cameraStatus === "mismatch" && !allowMismatch ? (
                  <button
                    onClick={() => setAllowMismatch(true)}
                    className="mt-3 h-9 rounded-full border border-red-500/30 px-5 text-sm text-red-600"
                  >
                    Compare anyway (align manually later)
                  </button>
                ) : null}
              </div>

              {comparison.temporal.suggested_offset_ms_b !== null ? (
                <div className="rounded-xl border border-[var(--border)] p-4 text-sm">
                  <p>
                    Suggested comparison action start: {comparison.temporal.suggested_offset_ms_b} ms
                    {comparison.temporal.suggestion_confidence !== null
                      ? `, confidence ${(comparison.temporal.suggestion_confidence * 100).toFixed(0)}%`
                      : ""}
                  </p>
                  <button
                    onClick={() => setOffsetB(Math.min(maxOffsetB, Math.max(0, Math.round(comparison.temporal.suggested_offset_ms_b ?? offsetB))))}
                    className="mt-3 h-9 rounded-full border border-[var(--border)] px-5 text-sm"
                  >
                    Use suggestion
                  </button>
                </div>
              ) : null}

              <div className="flex flex-wrap gap-6">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-[var(--muted)]">Baseline start (ms)</span>
                  <input
                    type="number"
                    min={0} max={maxOffsetA} step={1} disabled={alignSaving}
                    value={offsetA}
                    onChange={(e) => setOffsetA(Math.min(maxOffsetA, Math.max(0, Math.round(Number(e.target.value) || 0))))}
                    className="h-10 w-36 rounded-xl border border-[var(--border)] bg-transparent px-3 tabular-nums"
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-[var(--muted)]">Comparison start (ms)</span>
                  <input
                    type="number"
                    min={0} max={maxOffsetB} step={1} disabled={alignSaving}
                    value={offsetB}
                    onChange={(e) => setOffsetB(Math.min(maxOffsetB, Math.max(0, Math.round(Number(e.target.value) || 0))))}
                    className="h-10 w-36 rounded-xl border border-[var(--border)] bg-transparent px-3 tabular-nums"
                  />
                </label>
              </div>
            </>
          ) : null}

          <div className="flex flex-wrap gap-3">
            <button
              onClick={() => setStep("comparison")}
              disabled={comparing || alignSaving}
              className="h-12 rounded-full border border-[var(--border)] px-8"
            >
              Back
            </button>
            <button
              onClick={() => void handleCreateWorkbench()}
              disabled={!comparison || comparing || alignSaving || (cameraStatus === "mismatch" && !allowMismatch)}
              className="h-12 rounded-full bg-[var(--accent)] px-8 text-[var(--surface)] disabled:opacity-40"
            >
              {alignSaving ? "Saving action starts…" : "Create and open workbench"}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function ClipPickStep({
  homeCourt,
  title,
  subtitle,
  kind,
  clips,
  templateId,
  playerId,
  selected,
  onPicked,
  onUploaded,
  onMessage,
  children,
}: {
  homeCourt: boolean;
  title: string;
  subtitle: string;
  kind: ClipKind;
  clips: ClipMeta[];
  templateId: string | null;
  playerId: string | null;
  selected: ClipMeta | null;
  onPicked: (clip: ClipMeta) => void;
  onUploaded: (clip: ClipMeta) => Promise<void>;
  onMessage: (message: string | null) => void;
  children: React.ReactNode;
}) {
  const [uploading, setUploading] = useState(false);
  const [homeCourtSelection, setHomeCourtSelection] = useState<HomeCourtSelection | null>(null);
  const pendingUpload = useRef<AbortController | null>(null);
  useEffect(() => () => pendingUpload.current?.abort(), []);

  async function handleFile(file: File, source?: HomeCourtSourceInput) {
    if (!playerId || !templateId || pendingUpload.current) return;
    const controller = new AbortController();
    pendingUpload.current = controller;
    onMessage(null);
    setUploading(true);
    try {
      if (source) await validateHomeCourtImport(file, source, controller.signal);
      else validateClipFile(file);
      const response = await uploadClip(playerId, { video: file, templateId, kind, source }, controller.signal);
      if (!response.ok) throw await responseError(response);
      const clip = (await response.json()) as ClipMeta;
      if (!controller.signal.aborted) await onUploaded(clip);
    } catch (error) {
      if (!controller.signal.aborted) onMessage(error instanceof Error ? error.message : "Upload failed. Please try again.");
    } finally {
      if (pendingUpload.current === controller) pendingUpload.current = null;
      if (!controller.signal.aborted) setUploading(false);
    }
  }

  return (
    <section className="flex flex-col gap-5 rounded-2xl border border-[var(--border)] p-6">
      <fieldset disabled={uploading} className="contents">
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">{subtitle}</p>
      </div>

      <CameraGuide />

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-[var(--muted)]">Existing clip</span>
        <select
          value={selected?.clip_id ?? ""}
          onChange={(e) => {
            const clip = clips.find((item) => item.clip_id === e.target.value);
            if (clip) onPicked(clip);
          }}
          className="h-10 rounded-xl border border-[var(--border)] bg-transparent px-3"
        >
          <option value="">Choose a {kind === "baseline" ? "baseline" : "comparison"} clip</option>
          {clips.map((clip) => (
            <option key={clip.clip_id} value={clip.clip_id}>
              {clip.filename} · {formatDuration(clip.duration_ms)}
            </option>
          ))}
        </select>
        {clips.length === 0 ? (
          <span className="text-xs text-[var(--muted)]">No {kind === "baseline" ? "baseline" : "comparison"} clips for this template yet. Upload one below.</span>
        ) : null}
      </label>

      {homeCourt ? (
        <div className="flex flex-col gap-4">
          <HomeCourtClipSelector disabled={uploading} onSelect={setHomeCourtSelection} />
          <button disabled={!homeCourtSelection || uploading} onClick={() => homeCourtSelection && void handleFile(homeCourtSelection.file, homeCourtSelection.source)}
            className="h-12 w-fit rounded-full bg-[var(--accent)] px-6 text-[var(--surface)] disabled:opacity-40">Upload selected shot</button>
        </div>
      ) : <label className="flex flex-col gap-1 text-sm">
        <span className="text-[var(--muted)]">Or upload a new video</span>
        <input
          type="file"
          disabled={uploading}
          accept="video/mp4,video/quicktime,video/webm"
          onChange={(e) => {
            const file = e.target.files?.[0] ?? null;
            e.target.value = "";
            if (file) void handleFile(file);
          }}
          className="text-sm"
        />
      </label>}

      {uploading ? <p role="status" className="text-sm text-[var(--muted)]">Uploading and processing video…</p> : null}

      <div className="flex flex-wrap gap-3">{children}</div>
      </fieldset>
    </section>
  );
}
