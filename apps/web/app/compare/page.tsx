"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  createPlayer,
  createTemplate,
  deletePlayer,
  getPlayer,
  listPlayers,
  type CameraCheckResult,
  type ClipMeta,
  type ComparisonSummary,
  type Player,
  type PlayerDetail,
} from "@/lib/compare-api";

const CAMERA_BADGE: Record<string, string> = {
  match: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  suspect: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  mismatch: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
};

const CAMERA_LABEL: Record<string, string> = {
  match: "机位匹配",
  suspect: "机位疑似偏移",
  mismatch: "机位不一致",
};

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

function clipLabel(clip: ClipMeta): string {
  return `${clip.filename} · ${formatDuration(clip.duration_ms)} · ${formatDate(clip.created_at)}`;
}

export default function ComparePage() {
  const [players, setPlayers] = useState<Player[] | null>(null);
  const [details, setDetails] = useState<Record<string, PlayerDetail>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  const refresh = useCallback(async () => {
    try {
      const list = await listPlayers();
      setPlayers(list);
      const settled = await Promise.allSettled(list.map((player) => getPlayer(player.player_id)));
      const map: Record<string, PlayerDetail> = {};
      for (const result of settled) {
        if (result.status === "fulfilled") map[result.value.player.player_id] = result.value;
      }
      setDetails(map);
    } catch (error) {
      setPlayers([]);
      setMessage(
        error instanceof TypeError
          ? "无法连接对比服务，请稍后重试。"
          : error instanceof Error
            ? error.message
            : "加载学员列表失败，请刷新重试。",
      );
    }
  }, []);

  useEffect(() => {
    // Fetch-on-mount: refresh() sets state only after awaited network calls.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  async function handleCreatePlayer() {
    const name = newName.trim();
    if (!name) return;
    setMessage(null);
    try {
      await createPlayer(name);
      setNewName("");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "创建学员失败，请重试。");
    }
  }

  if (players === null) {
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col items-center gap-6 px-6 py-10">
        <h1 className="text-2xl font-semibold">动作对比</h1>
        <p role="status" className="text-zinc-600 dark:text-zinc-400">正在加载学员档案…</p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-8 px-6 py-10">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">动作对比</h1>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            把学员的基准动作存档和今天的动作逐帧叠在一起看。
          </p>
        </div>
        <Link
          href="/compare/new"
          className="h-10 rounded-full bg-foreground px-6 leading-10 text-background"
        >
          新建对比
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleCreatePlayer();
          }}
          placeholder="学员姓名"
          className="h-10 w-48 rounded-full border border-black/[.08] bg-transparent px-4 text-sm outline-none focus:border-foreground dark:border-white/[.145]"
        />
        <button
          onClick={() => void handleCreatePlayer()}
          disabled={!newName.trim()}
          className="h-10 rounded-full border border-black/[.08] px-6 text-sm disabled:opacity-40 dark:border-white/[.145]"
        >
          新建学员
        </button>
      </div>

      {message ? (
        <p role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/[.06] p-4 text-sm text-zinc-700 dark:text-zinc-300">
          {message}
        </p>
      ) : null}

      {players.length === 0 && !message ? (
        <div className="rounded-2xl border border-black/[.08] p-8 text-center dark:border-white/[.145]">
          <h2 className="text-lg font-semibold">还没有学员档案</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-zinc-600 dark:text-zinc-400">
            先在上方为学员创建档案，再录一段标准动作的基准视频存档。
            之后每次训练都录一段对比视频，系统会逐帧对齐两次动作，帮你看清动作变化。
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-4">
          {players.map((player) => (
            <PlayerCard
              key={player.player_id}
              player={player}
              detail={details[player.player_id] ?? null}
              onChanged={refresh}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function PlayerCard({
  player,
  detail,
  onChanged,
}: {
  player: Player;
  detail: PlayerDetail | null;
  onChanged: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [templateName, setTemplateName] = useState("");
  const [templatePhases, setTemplatePhases] = useState("准备 发力 收势");

  async function handleCreateTemplate() {
    const name = templateName.trim();
    if (!name) return;
    const phases = templatePhases.split(/[,，\s]+/).map((p) => p.trim()).filter(Boolean);
    if (phases.length === 0) {
      setMessage("请至少填写一个阶段名称。");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await createTemplate(player.player_id, name, phases);
      setTemplateName("");
      setTemplatePhases("准备 发力 收势");
      await onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "创建模板失败，请重试。");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm(`确定删除学员「${player.name}」？其模板、视频片段和对比记录会一并删除。`)) return;
    setBusy(true);
    setMessage(null);
    try {
      await deletePlayer(player.player_id);
      await onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除失败，请重试。");
      setBusy(false);
    }
  }

  const template = detail?.templates[0];
  const firstTemplateId = template?.template_id ?? null;

  return (
    <li className="rounded-2xl border border-black/[.08] p-5 dark:border-white/[.145]">
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex-1 text-left"
          aria-expanded={expanded}
        >
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-lg font-semibold">{player.name}</span>
            <span className="text-xs text-zinc-500">
              {detail ? `${detail.templates.length} 个模板 · ${detail.clips.length} 段视频 · ${detail.comparisons.length} 次对比` : "加载中…"}
            </span>
          </div>
        </button>
        <Link
          href={firstTemplateId
            ? `/compare/new?player=${player.player_id}&template=${firstTemplateId}`
            : `/compare/new?player=${player.player_id}`}
          className="h-9 rounded-full bg-foreground px-5 text-sm leading-9 text-background"
        >
          新建对比
        </Link>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="h-9 rounded-full border border-black/[.08] px-4 text-sm dark:border-white/[.145]"
          aria-expanded={expanded}
        >
          {expanded ? "收起" : "展开"}
        </button>
        <button
          onClick={() => void handleDelete()}
          disabled={busy}
          className="h-9 rounded-full border border-red-500/30 px-4 text-sm text-red-600 disabled:opacity-40 dark:text-red-400"
        >
          删除
        </button>
      </div>

      {message ? (
        <p role="status" className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">{message}</p>
      ) : null}

      {expanded ? (
        <div className="mt-5 flex flex-col gap-6 border-t border-black/[.05] pt-5 dark:border-white/[.08]">
          {!detail ? (
            <p role="status" className="text-sm text-zinc-600 dark:text-zinc-400">正在加载详情…</p>
          ) : (
            <>
              <section>
                <h3 className="mb-2 text-sm font-semibold">动作模板</h3>
                {detail.templates.length === 0 ? (
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">还没有模板，先在下方创建一个。</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {detail.templates.map((item) => (
                      <li key={item.template_id} className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="font-medium">{item.name}</span>
                        {item.default_phases.map((phase) => (
                          <span
                            key={phase}
                            className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                          >
                            {phase}
                          </span>
                        ))}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <input
                    value={templateName}
                    onChange={(e) => setTemplateName(e.target.value)}
                    placeholder="模板名称，如 罚球"
                    className="h-9 w-44 rounded-full border border-black/[.08] bg-transparent px-4 text-sm outline-none focus:border-foreground dark:border-white/[.145]"
                  />
                  <input
                    value={templatePhases}
                    onChange={(e) => setTemplatePhases(e.target.value)}
                    placeholder="阶段，空格或逗号分隔"
                    className="h-9 w-56 rounded-full border border-black/[.08] bg-transparent px-4 text-sm outline-none focus:border-foreground dark:border-white/[.145]"
                  />
                  <button
                    onClick={() => void handleCreateTemplate()}
                    disabled={busy || !templateName.trim()}
                    className="h-9 rounded-full border border-black/[.08] px-5 text-sm disabled:opacity-40 dark:border-white/[.145]"
                  >
                    新建动作模板
                  </button>
                </div>
              </section>

              <section>
                <h3 className="mb-2 text-sm font-semibold">视频片段</h3>
                {detail.clips.length === 0 ? (
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">
                    还没有视频。新建一次对比，上传基准和对比两段视频。
                  </p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {detail.clips.slice(0, 8).map((clip) => (
                      <li key={clip.clip_id} className="flex flex-wrap items-center gap-2 text-sm">
                        <span className={`rounded-full px-2 py-0.5 text-xs ${clip.kind === "baseline"
                          ? "bg-sky-500/10 text-sky-700 dark:text-sky-400"
                          : "bg-violet-500/10 text-violet-700 dark:text-violet-400"}`}
                        >
                          {clip.kind === "baseline" ? "基准" : "对比"}
                        </span>
                        <span className="text-zinc-700 dark:text-zinc-300">{clipLabel(clip)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section>
                <h3 className="mb-2 text-sm font-semibold">历史对比</h3>
                {detail.comparisons.length === 0 ? (
                  <p className="text-sm text-zinc-600 dark:text-zinc-400">还没有对比记录。</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {detail.comparisons.slice(0, 8).map((item) => (
                      <ComparisonRow key={item.comparison_id} item={item} clips={detail.clips} />
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>
      ) : null}
    </li>
  );
}

function ComparisonRow({ item, clips }: { item: ComparisonSummary; clips: ClipMeta[] }) {
  const baseline = clips.find((clip) => clip.clip_id === item.baseline_clip_id);
  const comparison = clips.find((clip) => clip.clip_id === item.comparison_clip_id);
  const status = (["match", "suspect", "mismatch"].includes(item.camera_status)
    ? item.camera_status
    : "suspect") as CameraCheckResult["status"];
  return (
    <li>
      <Link
        href={`/compare/${item.comparison_id}`}
        className="flex flex-wrap items-center gap-2 text-sm hover:underline"
      >
        <span className={`rounded-full border px-2 py-0.5 text-xs ${CAMERA_BADGE[status]}`}>
          {CAMERA_LABEL[status]}
        </span>
        <span className="text-zinc-700 dark:text-zinc-300">
          {baseline ? baseline.filename : "基准片段"} vs {comparison ? comparison.filename : "对比片段"}
        </span>
        <span className="text-xs text-zinc-500">{formatDate(item.created_at)}</span>
      </Link>
    </li>
  );
}
