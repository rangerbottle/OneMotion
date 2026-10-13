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
  match: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700",
  suspect: "border-amber-500/30 bg-amber-500/10 text-amber-700",
  mismatch: "border-red-500/30 bg-red-500/10 text-red-700",
};

const CAMERA_LABEL: Record<string, string> = {
  match: "Camera matched",
  suspect: "Camera may have moved",
  mismatch: "Camera mismatch",
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
          ? "Cannot connect to the comparison service. Please try again."
          : error instanceof Error
            ? error.message
            : "Could not load players. Refresh to try again.",
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
      setMessage(error instanceof Error ? error.message : "Could not create the player. Please try again.");
    }
  }

  if (players === null) {
    return (
      <div className="page-shell page-shell-narrow flex flex-1 flex-col items-center gap-6">
        <h1 className="page-title">Movement comparison</h1>
        <p role="status" className="text-[var(--muted)]">Loading player profiles…</p>
      </div>
    );
  }

  return (
    <div className="page-shell page-shell-narrow flex flex-1 flex-col gap-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="page-title">Movement comparison</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Compare a saved baseline with a recent clip, frame by frame.
          </p>
        </div>
        <Link
          href="/compare/new"
          className="h-10 rounded-full bg-[var(--accent)] px-6 leading-10 text-[var(--surface)]"
        >
          New comparison
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleCreatePlayer();
          }}
          placeholder="Player name"
          className="h-10 w-48 rounded-full border border-[var(--border)] bg-transparent px-4 text-sm outline-none focus:border-foreground"
        />
        <button
          onClick={() => void handleCreatePlayer()}
          disabled={!newName.trim()}
          className="h-10 rounded-full border border-[var(--border)] px-6 text-sm disabled:opacity-40"
        >
          Create player
        </button>
      </div>

      {message ? (
        <p role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/[.06] p-4 text-sm text-[var(--foreground)]">
          {message}
        </p>
      ) : null}

      {players.length === 0 && !message ? (
        <div className="rounded-2xl border border-[var(--border)] p-8 text-center">
          <h2 className="text-lg font-semibold">No player profiles yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-[var(--muted)]">
            Create a player profile above, then save a baseline clip.
            Record another clip after practice to review changes in the movement.
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
  const [templatePhases, setTemplatePhases] = useState("Preparation Drive Follow-through");

  async function handleCreateTemplate() {
    const name = templateName.trim();
    if (!name) return;
    const phases = templatePhases.split(/[,，\s]+/).map((p) => p.trim()).filter(Boolean);
    if (phases.length === 0) {
      setMessage("Enter at least one phase name.");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await createTemplate(player.player_id, name, phases);
      setTemplateName("");
      setTemplatePhases("Preparation Drive Follow-through");
      await onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not create the template. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm(`Delete player ${player.name}? This also deletes their templates, clips, and comparisons.`)) return;
    setBusy(true);
    setMessage(null);
    try {
      await deletePlayer(player.player_id);
      await onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not delete. Please try again.");
      setBusy(false);
    }
  }

  const template = detail?.templates[0];
  const firstTemplateId = template?.template_id ?? null;

  return (
    <li className="rounded-2xl border border-[var(--border)] p-5">
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex-1 text-left"
          aria-expanded={expanded}
        >
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-lg font-semibold">{player.name}</span>
            <span className="text-xs text-[var(--muted)]">
              {detail ? `${detail.templates.length} templates · ${detail.clips.length} clips · ${detail.comparisons.length} comparisons` : "Loading…"}
            </span>
          </div>
        </button>
        <Link
          href={firstTemplateId
            ? `/compare/new?player=${player.player_id}&template=${firstTemplateId}`
            : `/compare/new?player=${player.player_id}`}
          className="h-9 rounded-full bg-[var(--accent)] px-5 text-sm leading-9 text-[var(--surface)]"
        >
          New comparison
        </Link>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="h-9 rounded-full border border-[var(--border)] px-4 text-sm"
          aria-expanded={expanded}
        >
          {expanded ? "Collapse" : "Expand"}
        </button>
        <button
          onClick={() => void handleDelete()}
          disabled={busy}
          className="h-9 rounded-full border border-red-500/30 px-4 text-sm text-red-600 disabled:opacity-40"
        >
          Delete
        </button>
      </div>

      {message ? (
        <p role="status" className="mt-3 text-sm text-[var(--muted)]">{message}</p>
      ) : null}

      {expanded ? (
        <div className="mt-5 flex flex-col gap-6 border-t border-[var(--border)] pt-5">
          {!detail ? (
            <p role="status" className="text-sm text-[var(--muted)]">Loading details…</p>
          ) : (
            <>
              <section>
                <h3 className="mb-2 text-sm font-semibold">Action template</h3>
                {detail.templates.length === 0 ? (
                  <p className="text-sm text-[var(--muted)]">No templates yet. Create one below.</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {detail.templates.map((item) => (
                      <li key={item.template_id} className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="font-medium">{item.name}</span>
                        {item.default_phases.map((phase) => (
                          <span
                            key={phase}
                            className="rounded-full bg-[var(--surface-muted)] px-2 py-0.5 text-xs text-[var(--muted)]"
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
                    placeholder="Template name, e.g. Free throw"
                    className="h-9 w-44 rounded-full border border-[var(--border)] bg-transparent px-4 text-sm outline-none focus:border-foreground"
                  />
                  <input
                    value={templatePhases}
                    onChange={(e) => setTemplatePhases(e.target.value)}
                    placeholder="Phases, separated by spaces or commas"
                    className="h-9 w-56 rounded-full border border-[var(--border)] bg-transparent px-4 text-sm outline-none focus:border-foreground"
                  />
                  <button
                    onClick={() => void handleCreateTemplate()}
                    disabled={busy || !templateName.trim()}
                    className="h-9 rounded-full border border-[var(--border)] px-5 text-sm disabled:opacity-40"
                  >
                    Create action template
                  </button>
                </div>
              </section>

              <section>
                <h3 className="mb-2 text-sm font-semibold">Video clips</h3>
                {detail.clips.length === 0 ? (
                  <p className="text-sm text-[var(--muted)]">
                    No clips yet. Start a comparison and upload a baseline and a recent clip.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {detail.clips.slice(0, 8).map((clip) => (
                      <li key={clip.clip_id} className="flex flex-wrap items-center gap-2 text-sm">
                        <span className={`rounded-full px-2 py-0.5 text-xs ${clip.kind === "baseline"
                          ? "bg-sky-500/10 text-sky-700"
                          : "bg-violet-500/10 text-violet-700"}`}
                        >
                          {clip.kind === "baseline" ? "Baseline" : "Comparison"}
                        </span>
                        <span className="text-[var(--foreground)]">{clipLabel(clip)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section>
                <h3 className="mb-2 text-sm font-semibold">Comparison history</h3>
                {detail.comparisons.length === 0 ? (
                  <p className="text-sm text-[var(--muted)]">No comparisons yet.</p>
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
        <span className="text-[var(--foreground)]">
          {baseline ? baseline.filename : "Baseline clip"} vs {comparison ? comparison.filename : "Comparison clip"}
        </span>
        <span className="text-xs text-[var(--muted)]">{formatDate(item.created_at)}</span>
      </Link>
    </li>
  );
}
