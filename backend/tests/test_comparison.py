"""Evidence-aware scoring and slow-motion timing safeguards."""

from datetime import datetime, timezone

from app.analysis.compare import metric_deltas, similarity_score
from app.schemas.benchmark import BenchmarkProfile, MetricStats


def profile(*, timing_reliable: bool) -> BenchmarkProfile:
    return BenchmarkProfile(
        version="curry_v2" if not timing_reliable else "curry_v3",
        created_at=datetime.now(timezone.utc),
        source_clips=["reference"],
        backend="test",
        metrics={
            "shot_tempo_s": MetricStats(median=0.8, p25=0.75, p75=0.85, n=1),
            "release_angle_deg": MetricStats(median=60, p25=58, p75=62, n=1),
        },
        phase_timing=[],
        canonical_clip_id="reference",
        timing_mode="realtime" if timing_reliable else "slow_motion",
        timing_reliable=timing_reliable,
    )


EVIDENCE = {
    "shot_tempo_s": {"confidence": 0.9, "coverage": 1.0, "reliable": True},
    "release_angle_deg": {"confidence": 0.8, "coverage": 1.0, "reliable": True},
}


def test_slow_motion_template_disables_timing_delta() -> None:
    deltas = metric_deltas(
        {"shot_tempo_s": 1.2, "release_angle_deg": 60},
        profile(timing_reliable=False),
        EVIDENCE,
    )
    tempo = next(item for item in deltas if item.name == "shot_tempo_s")
    assert tempo.reliable is False
    assert tempo.delta is None
    assert "slow-motion" in (tempo.unavailable_reason or "")
    assert similarity_score(deltas, "timing") is None
    assert similarity_score(deltas, "form") == 100.0


def test_realtime_template_scores_timing() -> None:
    deltas = metric_deltas(
        {"shot_tempo_s": 0.8, "release_angle_deg": 60},
        profile(timing_reliable=True),
        EVIDENCE,
    )
    tempo = next(item for item in deltas if item.name == "shot_tempo_s")
    assert tempo.reliable is True
    assert tempo.delta == 0
    assert similarity_score(deltas, "timing") == 100.0


def test_missing_metric_is_returned_with_reason() -> None:
    deltas = metric_deltas(
        {"release_angle_deg": 60}, profile(timing_reliable=True), EVIDENCE
    )
    tempo = next(item for item in deltas if item.name == "shot_tempo_s")
    assert tempo.value is None
    assert tempo.reliable is False
    assert tempo.unavailable_reason
