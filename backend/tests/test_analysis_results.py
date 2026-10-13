"""Report policy invariants without filesystem, pose inference, or HTTP."""

from datetime import datetime, timezone

import pytest

from app.analysis.results import (
    apply_comparison_policy,
    build_comparison,
    measurement_inputs,
)
from app.schemas.analysis import AnalysisResult, CaptureQuality
from app.schemas.benchmark import BenchmarkProfile, MetricStats


@pytest.fixture
def comparison():
    reference = {"release_angle_deg": 60, "set_point_ratio": .2,
                 "elbow_angle_at_release_deg": 180, "shot_tempo_s": .8}
    template = BenchmarkProfile(
        version="curry_v3", created_at=datetime.now(timezone.utc), source_clips=["fixture"],
        backend="test", metrics={name: MetricStats(median=value, p25=value, p75=value, n=1)
                                 for name, value in reference.items()},
        phase_timing=[], canonical_clip_id="fixture", timing_mode="realtime", timing_reliable=True,
    )
    base = AnalysisResult(analysis_id="a" * 32, benchmark_version="curry_v3",
                          similarity_score=None, phases=[], metrics=[], feedback=[])
    evidence = {name: {"confidence": .9, "coverage": 1.0, "reliable": True}
                for name in reference}
    values = {**reference, "set_point_ratio": .3}
    return base, template, values, evidence


@pytest.mark.parametrize("status", ["pass", "warn", "fail"])
def test_policy_preserves_measurements_and_gates_before_scoring(comparison, status):
    base, template, values, evidence = comparison
    capture = CaptureQuality(status=status, side_view_score=.9 if status == "pass" else .65,
                             confidence=.95, body_visibility=1, reasons=["oblique view"])
    base = base.model_copy(update={"capture_quality": capture})
    result = build_comparison(base, template, values, evidence)
    assert result.measurement_evidence == evidence
    assert {metric.name: metric.value for metric in result.metrics} == values
    assert base.metrics == [] and base.similarity_score is None
    assert apply_comparison_policy(result) == result
    if status == "pass":
        # Fixed evidence weights preserve the existing scoring calculation.
        assert result.similarity_score == 88.1
        assert result.form_score == 83.3
        assert result.timing_score == 100
        assert [item.metric for item in result.feedback] == ["set_point_ratio"]
    else:
        assert result.similarity_score is None and result.form_score is None
        assert result.feedback == []
        assert all(metric.delta is None for metric in result.metrics if metric.category == "form")
        assert result.timing_score == (100 if status == "warn" else None)


def test_missing_capture_does_not_bypass_reference_timing_policy(comparison):
    base, template, values, evidence = comparison
    stored = build_comparison(base, template, values, evidence).model_copy(update={
        "timing_mode": "unknown", "timing_reliable": False,
    })
    result = apply_comparison_policy(stored)
    tempo = next(metric for metric in result.metrics if metric.category == "timing")
    assert not tempo.reliable and tempo.delta is None
    assert "not verified" in tempo.unavailable_reason
    assert result.timing_score is None
    assert result.form_score == result.similarity_score == 83.3
    assert result.measurement_evidence == evidence
    assert stored.metrics[-1].reliable  # The input report is unchanged.
    assert apply_comparison_policy(result) == result


def test_partial_raw_evidence_keeps_legacy_reliability(comparison):
    base, template, values, evidence = comparison
    stored = build_comparison(base, template, values, evidence)
    metrics = [metric.model_copy(update={"reliable": False, "delta": None,
               "unavailable_reason": "original tracking was weak"})
               if metric.name == "set_point_ratio" else metric for metric in stored.metrics]
    stored = stored.model_copy(update={
        "metrics": metrics,
        "measurement_evidence": {"release_angle_deg": {"confidence": .8}},
    })
    recovered_values, recovered_evidence = measurement_inputs(stored)
    assert recovered_evidence["release_angle_deg"]["confidence"] == .8
    assert recovered_evidence["release_angle_deg"]["reliable"] is True
    assert recovered_evidence["set_point_ratio"]["reliable"] is False
    repeated = build_comparison(stored, template, recovered_values, recovered_evidence)
    set_point = next(metric for metric in repeated.metrics if metric.name == "set_point_ratio")
    assert not set_point.reliable and set_point.delta is None
    assert repeated.feedback == []
    assert stored.measurement_evidence == {"release_angle_deg": {"confidence": .8}}


def test_old_frontal_warning_becomes_failure_without_duplicate_reasons(comparison):
    base, template, values, evidence = comparison
    base.capture_quality = CaptureQuality(status="warn", side_view_score=.2,
                                         confidence=.95, body_visibility=1)
    result = build_comparison(base, template, values, evidence)
    assert result.capture_quality.status == "fail"
    assert result.quality.status == "insufficient"
    assert result.similarity_score is result.form_score is result.timing_score is None
    assert all(metric.unavailable_reason for metric in result.metrics)
    assert apply_comparison_policy(result) == result


@pytest.mark.parametrize("missing_value", [False, True])
def test_stale_metric_cannot_bypass_rejected_or_missing_measurement(comparison, missing_value):
    base, template, values, evidence = comparison
    stored = build_comparison(base, template, values, evidence)
    if missing_value:
        stored = stored.model_copy(update={"metrics": [
            metric.model_copy(update={"value": None}) if metric.name == "set_point_ratio" else metric
            for metric in stored.metrics
        ]})
    else:
        stored = stored.model_copy(update={"measurement_evidence": {
            **evidence, "set_point_ratio": {**evidence["set_point_ratio"], "reliable": False,
                                           "reason": "original tracking was weak"},
        }})
    result = apply_comparison_policy(stored)
    set_point = next(metric for metric in result.metrics if metric.name == "set_point_ratio")
    assert not set_point.reliable and set_point.delta is None
    assert result.feedback == []
    assert result.similarity_score == 100
    assert apply_comparison_policy(result) == result
    recovered_values, recovered_evidence = measurement_inputs(result)
    repeated = build_comparison(result, template, recovered_values, recovered_evidence)
    assert repeated.metrics == result.metrics
    assert repeated.similarity_score == result.similarity_score
