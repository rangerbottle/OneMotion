"""JSON persistence helpers for the compare domain (players/templates/clips).

Same conventions as the analysis core: atomic writes, lock stripes keyed by
entity id, and metadata (ClipMeta) stored separately from the heavy pose
sequence (ShotSequence) so listing stays cheap.
"""

import json
from pathlib import Path

from app.core.storage import analysis_lock, atomic_write
from app.schemas.compare import (
    ActionTemplate,
    ClipMeta,
    ComparisonState,
    Player,
)
from app.schemas.pose import ShotSequence


def player_path(cfg, player_id: str) -> Path:
    return cfg.compare_players_dir / f"{player_id}.json"


def template_path(cfg, template_id: str) -> Path:
    return cfg.compare_templates_dir / f"{template_id}.json"


def clip_meta_path(cfg, clip_id: str) -> Path:
    return cfg.compare_clips_dir / f"{clip_id}.json"


def clip_pose_path(cfg, clip_id: str) -> Path:
    return cfg.compare_clips_dir / f"{clip_id}.pose.json"


def comparison_path(cfg, comparison_id: str) -> Path:
    return cfg.compare_comparisons_dir / f"{comparison_id}.json"


def ensure_dirs(cfg) -> None:
    for directory in (
        cfg.compare_players_dir,
        cfg.compare_templates_dir,
        cfg.compare_clips_dir,
        cfg.compare_comparisons_dir,
        cfg.compare_reports_dir,
        cfg.compare_videos_dir,
    ):
        directory.mkdir(parents=True, exist_ok=True)


def _load(path: Path, model):
    if not path.is_file():
        raise FileNotFoundError(str(path))
    return model.model_validate(json.loads(path.read_text(encoding="utf-8")))


def save_player(cfg, player: Player) -> None:
    atomic_write(player_path(cfg, player.player_id), player.model_dump_json(indent=2))


def load_player(cfg, player_id: str) -> Player:
    return _load(player_path(cfg, player_id), Player)


def list_players(cfg) -> list[Player]:
    if not cfg.compare_players_dir.is_dir():
        return []
    players = [
        _load(path, Player)
        for path in sorted(cfg.compare_players_dir.glob("*.json"))
    ]
    return sorted(players, key=lambda p: p.created_at)


def delete_player_file(cfg, player_id: str) -> None:
    player_path(cfg, player_id).unlink(missing_ok=True)


def save_template(cfg, template: ActionTemplate) -> None:
    atomic_write(template_path(cfg, template.template_id), template.model_dump_json(indent=2))


def load_template(cfg, template_id: str) -> ActionTemplate:
    return _load(template_path(cfg, template_id), ActionTemplate)


def list_templates(cfg, player_id: str) -> list[ActionTemplate]:
    if not cfg.compare_templates_dir.is_dir():
        return []
    return [
        t
        for t in (_load(path, ActionTemplate) for path in sorted(cfg.compare_templates_dir.glob("*.json")))
        if t.player_id == player_id
    ]


def delete_template_file(cfg, template_id: str) -> None:
    template_path(cfg, template_id).unlink(missing_ok=True)


def save_clip_meta(cfg, meta: ClipMeta) -> None:
    atomic_write(clip_meta_path(cfg, meta.clip_id), meta.model_dump_json(indent=2))


def load_clip_meta(cfg, clip_id: str) -> ClipMeta:
    return _load(clip_meta_path(cfg, clip_id), ClipMeta)


def list_clip_metas(cfg, player_id: str, template_id: str | None = None) -> list[ClipMeta]:
    if not cfg.compare_clips_dir.is_dir():
        return []
    metas = [
        m
        for m in (_load(path, ClipMeta) for path in sorted(cfg.compare_clips_dir.glob("*.json")) if ".pose." not in path.name)
        if m.player_id == player_id and (template_id is None or m.template_id == template_id)
    ]
    return sorted(metas, key=lambda m: m.created_at)


def save_clip_pose(cfg, clip_id: str, sequence: ShotSequence) -> None:
    atomic_write(clip_pose_path(cfg, clip_id), sequence.model_dump_json())


def load_clip_pose(cfg, clip_id: str) -> ShotSequence:
    return ShotSequence.model_validate_json(clip_pose_path(cfg, clip_id).read_text(encoding="utf-8"))


def delete_clip_files(cfg, clip: ClipMeta) -> None:
    clip_meta_path(cfg, clip.clip_id).unlink(missing_ok=True)
    clip_pose_path(cfg, clip.clip_id).unlink(missing_ok=True)
    for path in cfg.compare_videos_dir.glob(f"{clip.clip_id}.*"):
        path.unlink(missing_ok=True)


def save_comparison(cfg, state: ComparisonState) -> None:
    atomic_write(comparison_path(cfg, state.comparison_id), state.model_dump_json(indent=2))


def load_comparison(cfg, comparison_id: str) -> ComparisonState:
    return _load(comparison_path(cfg, comparison_id), ComparisonState)


def delete_comparison_file(cfg, comparison_id: str) -> None:
    comparison_path(cfg, comparison_id).unlink(missing_ok=True)


def list_comparisons(cfg, player_id: str) -> list[ComparisonState]:
    if not cfg.compare_comparisons_dir.is_dir():
        return []
    states = [
        s
        for s in (_load(path, ComparisonState) for path in sorted(cfg.compare_comparisons_dir.glob("*.json")))
        if s.player_id == player_id
    ]
    return sorted(states, key=lambda s: s.created_at)


def lock(cfg, entity_id: str, *, blocking: bool = True):
    return analysis_lock(cfg.data_dir, entity_id, blocking=blocking)
