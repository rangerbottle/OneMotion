"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { responseError } from "@/lib/api";
import { validateClipFile } from "@/lib/clip";
import {
  createComparison,
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
  match: "✅ 机位匹配",
  suspect: "⚠️ 机位疑似偏移，对比结果可能有误差",
  mismatch: "❌ 明显不是同一机位",
};

/** Side-view court + camera placement guidance, shared by both capture steps. */
function CameraGuide() {
  return (
    <div className="rounded-2xl border border-black/[.08] p-5 dark:border-white/[.145]">
      <div className="flex flex-wrap items-center gap-6">
        <svg viewBox="0 0 320 180" className="w-full max-w-xs" role="img" aria-label="机位示意图">
          {/* court floor */}
          <rect x="20" y="140" width="280" height="8" rx="2" className="fill-zinc-300 dark:fill-zinc-700" />
          {/* hoop */}
          <line x1="260" y1="60" x2="260" y2="140" stroke="currentColor" strokeWidth="3" />
          <rect x="246" y="52" width="28" height="10" rx="2" className="fill-zinc-400 dark:fill-zinc-600" />
          {/* player */}
          <circle cx="150" cy="72" r="8" className="fill-zinc-500" />
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
          <text x="86" y="172" fontSize="11" className="fill-zinc-500">3–5 m</text>
          {/* height annotation 1.2-1.5m */}
          <line x1="8" y1="96" x2="8" y2="140" stroke="currentColor" strokeWidth="1" strokeDasharray="4 3" />
          <text x="12" y="122" fontSize="11" className="fill-zinc-500">1.2–1.5 m</text>
        </svg>
        <ul className="flex-1 space-y-1 text-sm text-zinc-600 dark:text-zinc-400">
          <li>侧面 90° 拍摄：镜头正对动作方向，人物全身入镜。</li>
          <li>手机固定在 1.2–1.5 m 高度，距离动作路线 3–5 m。</li>
          <li>竖屏 / 横屏均可，但基准和对比两次拍摄请保持一致。</li>
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
        <div className="mx-auto flex w-full max-w-3xl flex-1 items-center justify-center px-6 py-10">
          <p role="status" className="text-zinc-600 dark:text-zinc-400">正在加载…</p>
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
  const creatingRef = useRef(false);
  const runRef = useRef(0);

  const loadDetail = useCallback(async (playerId: string) => {
    const data = await getPlayer(playerId);
    setDetail(data);
    return data;
  }, []);

  useEffect(() => {
    if (playerParam) {
      // Fetch-on-mount: loadDetail() sets state only after awaited network calls.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadDetail(playerParam)
        .then((data) => {
          // ?player= without ?template=: pick the first template so the clip
          // lists are not permanently empty for fresh players.
          if (!templateParam && data.templates[0]) {
            setSelectedTemplateId(data.templates[0].template_id);
          }
        })
        .catch((error) => {
          setMessage(error instanceof Error ? error.message : "加载学员信息失败。");
        });
      return;
    }
    listPlayers()
      .then(setPlayers)
      .catch((error) => {
        setPlayers([]);
        setMessage(error instanceof Error ? error.message : "加载学员列表失败。");
      });
  }, [playerParam, templateParam, loadDetail]);

  async function handlePickPlayer(playerId: string) {
    setSelectedPlayerId(playerId);
    setSelectedTemplateId(null);
    setDetail(null);
    setMessage(null);
    try {
      const data = await loadDetail(playerId);
      if (data.templates[0]) setSelectedTemplateId(data.templates[0].template_id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "加载学员信息失败。");
    }
  }

  async function handleStart() {
    if (!selectedPlayerId || !selectedTemplateId) {
      setMessage("请先选择学员和动作模板。");
      return;
    }
    setMessage(null);
    setStep("baseline");
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
    setComparison(null);
    setCompareFailed(false);
    setAllowMismatch(false);
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
    if (creatingRef.current) return; // double-click guard: never POST twice
    creatingRef.current = true;
    const run = ++runRef.current;
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
      setMessage(error instanceof Error ? error.message : "机位校验失败，请重试。");
    } finally {
      creatingRef.current = false;
      if (run === runRef.current) setComparing(false);
    }
  }

  function handleEnterAlign() {
    setStep("align");
    if (!comparison && !comparing) void runComparison();
  }

  const cameraStatus: CameraCheckResult["status"] | null =
    comparison?.camera_check?.status ?? null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-10">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">新建动作对比</h1>
        <Link href="/compare" className="text-sm text-zinc-500 hover:underline">返回列表</Link>
      </div>

      <ol className="flex gap-2 text-sm">
        {(playerParam ? ["基准动作", "对比动作", "校验与对齐"] : ["选择学员", "基准动作", "对比动作", "校验与对齐"]).map(
          (label, index) => {
            const stepOrder: Record<string, number> = playerParam
              ? { baseline: 0, comparison: 1, align: 2 }
              : { setup: 0, baseline: 1, comparison: 2, align: 3 };
            const current = stepOrder[step];
            return (
              <li
                key={label}
                className={`rounded-full px-3 py-1 ${index === current
                  ? "bg-foreground text-background"
                  : index < current
                    ? "bg-zinc-100 text-zinc-500 dark:bg-zinc-800"
                    : "border border-black/[.08] text-zinc-500 dark:border-white/[.145]"}`}
              >
                {label}
              </li>
            );
          },
        )}
      </ol>

      {message ? (
        <p role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/[.06] p-4 text-sm text-zinc-700 dark:text-zinc-300">
          {message}
        </p>
      ) : null}

      {step === "setup" ? (
        <section className="flex flex-col gap-5 rounded-2xl border border-black/[.08] p-6 dark:border-white/[.145]">
          <h2 className="text-lg font-semibold">选择学员和动作模板</h2>
          {!players ? (
            <p role="status" className="text-sm text-zinc-600 dark:text-zinc-400">正在加载学员…</p>
          ) : (
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-zinc-600 dark:text-zinc-400">学员</span>
              <select
                value={selectedPlayerId ?? ""}
                onChange={(e) => void handlePickPlayer(e.target.value)}
                className="h-10 rounded-xl border border-black/[.08] bg-transparent px-3 dark:border-white/[.145]"
              >
                <option value="">请选择学员</option>
                {players.map((player) => (
                  <option key={player.player_id} value={player.player_id}>{player.name}</option>
                ))}
              </select>
            </label>
          )}
          {selectedPlayerId ? (
            !detail ? (
              <p role="status" className="text-sm text-zinc-600 dark:text-zinc-400">正在加载模板…</p>
            ) : (
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-zinc-600 dark:text-zinc-400">动作模板</span>
                <select
                  value={selectedTemplateId ?? ""}
                  onChange={(e) => setSelectedTemplateId(e.target.value || null)}
                  className="h-10 rounded-xl border border-black/[.08] bg-transparent px-3 dark:border-white/[.145]"
                >
                  <option value="">请选择模板</option>
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
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              该学员还没有动作模板，请先在“动作对比”列表页为其创建模板。
            </p>
          ) : null}
          <button
            onClick={() => void handleStart()}
            disabled={!selectedPlayerId || !selectedTemplateId}
            className="h-12 w-fit rounded-full bg-foreground px-8 text-background disabled:opacity-40"
          >
            下一步
          </button>
        </section>
      ) : null}

      {step === "baseline" ? (
        <ClipPickStep
          title="基准动作（历史版）"
          subtitle="选择或上传学员之前录好的标准动作视频。"
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
            className="h-12 rounded-full border border-black/[.08] px-8 dark:border-white/[.145]"
          >
            上一步
          </button>
          <button
            onClick={() => setStep("comparison")}
            disabled={!baselineClip}
            className="h-12 rounded-full bg-foreground px-8 text-background disabled:opacity-40"
          >
            下一步
          </button>
        </ClipPickStep>
      ) : null}

      {step === "comparison" ? (
        <ClipPickStep
          title="对比动作（今天）"
          subtitle="选择或上传今天训练时录制的动作视频。"
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
            className="h-12 rounded-full border border-black/[.08] px-8 dark:border-white/[.145]"
          >
            上一步
          </button>
          <button
            onClick={handleEnterAlign}
            disabled={!comparisonClip}
            className="h-12 rounded-full bg-foreground px-8 text-background disabled:opacity-40"
          >
            下一步
          </button>
        </ClipPickStep>
      ) : null}

      {step === "align" ? (
        <section className="flex flex-col gap-5 rounded-2xl border border-black/[.08] p-6 dark:border-white/[.145]">
          <h2 className="text-lg font-semibold">校验与对齐</h2>

          {comparing ? (
            <p role="status" className="text-sm text-zinc-600 dark:text-zinc-400">
              正在机位校验与对齐…这可能需要几秒钟。
            </p>
          ) : compareFailed ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-zinc-600 dark:text-zinc-400">机位校验未完成。</p>
              <button
                onClick={() => void runComparison()}
                className="h-9 rounded-full border border-black/[.08] px-5 text-sm dark:border-white/[.145]"
              >
                重试校验
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
                  {cameraStatus ? CAMERA_TEXT[cameraStatus] : "未检测到机位信息"}
                  {comparison.camera_check
                    ? `（匹配特征 ${comparison.camera_check.matches}，内点比例 ${(comparison.camera_check.inlier_ratio * 100).toFixed(0)}%）`
                    : ""}
                </p>
                {cameraStatus === "mismatch" && !allowMismatch ? (
                  <button
                    onClick={() => setAllowMismatch(true)}
                    className="mt-3 h-9 rounded-full border border-red-500/30 px-5 text-sm text-red-600 dark:text-red-400"
                  >
                    仍要对比（稍后手动对齐）
                  </button>
                ) : null}
              </div>

              {comparison.temporal.suggested_offset_ms_b !== null ? (
                <div className="rounded-xl border border-black/[.08] p-4 text-sm dark:border-white/[.145]">
                  <p>
                    系统建议对比片动作起点：{comparison.temporal.suggested_offset_ms_b} ms
                    {comparison.temporal.suggestion_confidence !== null
                      ? `，置信度 ${(comparison.temporal.suggestion_confidence * 100).toFixed(0)}%`
                      : ""}
                  </p>
                  <button
                    onClick={() => setOffsetB(comparison.temporal.suggested_offset_ms_b ?? offsetB)}
                    className="mt-3 h-9 rounded-full border border-black/[.08] px-5 text-sm dark:border-white/[.145]"
                  >
                    采用建议
                  </button>
                </div>
              ) : null}

              <div className="flex flex-wrap gap-6">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-zinc-600 dark:text-zinc-400">基准片动作起点（ms）</span>
                  <input
                    type="number"
                    value={offsetA}
                    onChange={(e) => setOffsetA(Number(e.target.value) || 0)}
                    className="h-10 w-36 rounded-xl border border-black/[.08] bg-transparent px-3 tabular-nums dark:border-white/[.145]"
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-zinc-600 dark:text-zinc-400">对比片动作起点（ms）</span>
                  <input
                    type="number"
                    value={offsetB}
                    onChange={(e) => setOffsetB(Number(e.target.value) || 0)}
                    className="h-10 w-36 rounded-xl border border-black/[.08] bg-transparent px-3 tabular-nums dark:border-white/[.145]"
                  />
                </label>
              </div>
            </>
          ) : null}

          <div className="flex flex-wrap gap-3">
            <button
              onClick={() => setStep("comparison")}
              className="h-12 rounded-full border border-black/[.08] px-8 dark:border-white/[.145]"
            >
              上一步
            </button>
            <button
              onClick={() => {
                if (!comparison) return;
                // Persist the adjusted action-start offsets before entering
                // the workbench so the workspace opens with them applied.
                void patchComparison(comparison.comparison_id, {
                  temporal: { offset_ms_a: offsetA, offset_ms_b: offsetB },
                })
                  .catch(() => undefined) // defaults already persisted server-side
                  .finally(() => router.push(`/compare/${comparison.comparison_id}`));
              }}
              disabled={!comparison || (cameraStatus === "mismatch" && !allowMismatch)}
              className="h-12 rounded-full bg-foreground px-8 text-background disabled:opacity-40"
            >
              创建并进入工作台
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function ClipPickStep({
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

  async function handleFile(file: File) {
    if (!playerId || !templateId) return;
    try {
      validateClipFile(file);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "视频文件无效。");
      return;
    }
    onMessage(null);
    setUploading(true);
    try {
      const response = await uploadClip(playerId, { video: file, templateId, kind });
      if (!response.ok) throw await responseError(response);
      const clip = (await response.json()) as ClipMeta;
      await onUploaded(clip);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "上传失败，请重试。");
    } finally {
      setUploading(false);
    }
  }

  return (
    <section className="flex flex-col gap-5 rounded-2xl border border-black/[.08] p-6 dark:border-white/[.145]">
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{subtitle}</p>
      </div>

      <CameraGuide />

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-zinc-600 dark:text-zinc-400">选择已有片段</span>
        <select
          value={selected?.clip_id ?? ""}
          onChange={(e) => {
            const clip = clips.find((item) => item.clip_id === e.target.value);
            if (clip) onPicked(clip);
          }}
          className="h-10 rounded-xl border border-black/[.08] bg-transparent px-3 dark:border-white/[.145]"
        >
          <option value="">请选择{kind === "baseline" ? "基准" : "对比"}片段</option>
          {clips.map((clip) => (
            <option key={clip.clip_id} value={clip.clip_id}>
              {clip.filename} · {formatDuration(clip.duration_ms)}
            </option>
          ))}
        </select>
        {clips.length === 0 ? (
          <span className="text-xs text-zinc-500">该模板下还没有{kind === "baseline" ? "基准" : "对比"}片段，请直接上传。</span>
        ) : null}
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="text-zinc-600 dark:text-zinc-400">或上传新视频</span>
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
        {uploading ? (
          <span role="status" className="text-xs text-zinc-500">正在上传并处理视频…</span>
        ) : null}
      </label>

      <div className="flex flex-wrap gap-3">{children}</div>
    </section>
  );
}
