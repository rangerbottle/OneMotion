"""Pure report construction and comparison eligibility policy.

Measurement evidence belongs to the player clip. Capture suitability and
reference timing decide whether those measurements can be compared; they must
never overwrite the stored measurement evidence.
"""

from app.analysis import compare, feedback
from app.schemas.analysis import (
    AnalysisQuality,
    AnalysisResult,
    CaptureQuality,
    MetricValue,
    PhaseSegment,
)
from app.schemas.benchmark import BenchmarkProfile

MeasurementEvidence = dict[str, dict[str, float | bool | str | None]]

TIMING_UNAVAILABLE_REASON = (
    "reference playback speed is not verified as real time; timing comparison is disabled"
)
SOURCE_TIMING_UNAVAILABLE_REASON = (
    "source playback speed is not confirmed as real time; timing comparison is disabled"
)
CAPTURE_REASON_PREFIX = "capture is unsuitable for this comparison: "


def measurement_inputs(
    result: AnalysisResult,
) -> tuple[dict[str, float], MeasurementEvidence]:
    """Recover measurements without losing legacy or partially stored evidence.

    A missing raw entry falls back to that metric's persisted reliability. A
    single newer evidence entry must not make all other legacy metrics reliable.
    """
    values = {
        metric.name: metric.value
        for metric in result.metrics
        if metric.value is not None
    }
    evidence: MeasurementEvidence = {
        metric.name: {
            "confidence": metric.confidence,
            "coverage": metric.coverage,
            "reliable": metric.reliable,
            "reason": metric.unavailable_reason,
        }
        for metric in result.metrics
    }
    for name, item in result.measurement_evidence.items():
        evidence.setdefault(name, {}).update(item)
    return values, evidence


def migration_evidence(
    result: AnalysisResult, measured: MeasurementEvidence,
) -> MeasurementEvidence:
    """Fill evidence gaps on migration without upgrading rejected measurements.

    Explicit raw evidence remains authoritative. Older metrics without a raw
    entry keep a persisted rejection; freshly measured evidence fills the rest.
    """
    evidence = {name: dict(item) for name, item in measured.items()}
    for name, item in result.measurement_evidence.items():
        evidence.setdefault(name, {}).update(item)
    _, persisted = measurement_inputs(result)
    for name, item in persisted.items():
        if item.get("reliable") is False:
            evidence.setdefault(name, {}).update(item)
    return evidence


def analysis_quality(
    metrics: list[MetricValue],
    phases: list[PhaseSegment],
    capture: CaptureQuality | None,
) -> AnalysisQuality:
    reliable = [metric for metric in metrics if metric.reliable and metric.value is not None]
    missing = [metric.name for metric in metrics if not metric.reliable or metric.value is None]
    degraded = [phase.phase for phase in phases if phase.degraded or phase.censored]
    expected = len(metrics)
    reasons = []
    if missing:
        reasons.append(f"{len(missing)} of {expected} metrics lack reliable evidence")
    if degraded:
        reasons.append("one or more shooting phases contain missing or clipped pose data")
    if capture and capture.status != "pass":
        reasons.extend(capture.reasons)
    status = "valid"
    if len(reliable) < 3 or (capture and capture.status == "fail"):
        status = "insufficient"
    elif missing or degraded or (capture and capture.status != "pass"):
        status = "degraded"
    return AnalysisQuality(
        status=status,
        coverage=round(len(reliable) / max(expected, 1), 3),
        valid_metrics=len(reliable),
        expected_metrics=expected,
        missing_metrics=missing,
        degraded_phases=degraded,
        reasons=reasons,
    )


def _unavailable(metric: MetricValue, reason: str) -> MetricValue:
    return metric.model_copy(update={
        "reliable": False,
        "delta": None,
        "delta_pct": None,
        "robust_z_score": None,
        "unavailable_reason": reason,
    })


def apply_comparison_policy(result: AnalysisResult) -> AnalysisResult:
    """Apply the same gates and scoring to fresh and persisted reports.

    This operation is idempotent, preserves raw measurements, and does not need
    a benchmark or replay media. In particular, unknown reference timing remains
    gated even when an old report has no capture assessment or its media expired.
    """
    capture = result.capture_quality
    if capture and capture.side_view_score < 0.55 and capture.status != "fail":
        capture = capture.model_copy(update={"status": "fail"})
    metrics = []
    for metric in result.metrics:
        raw_evidence = result.measurement_evidence.get(metric.name, {})
        if raw_evidence.get("reliable") is False:
            reason = raw_evidence.get("reason") or metric.unavailable_reason
            metric = _unavailable(metric, str(reason or "original measurement lacks reliable evidence"))
        if metric.value is None:
            metric = _unavailable(metric, metric.unavailable_reason or "metric could not be measured from this clip")
        if metric.category == "timing" and not result.timing_reliable:
            metric = _unavailable(metric, TIMING_UNAVAILABLE_REASON)
        if metric.category == "timing" and result.source and result.source.timing_mode != "realtime":
            metric = _unavailable(metric, SOURCE_TIMING_UNAVAILABLE_REASON)
        if capture and (
            capture.status == "fail"
            or (capture.status == "warn" and metric.category == "form")
        ):
            reason = metric.unavailable_reason or ""
            if CAPTURE_REASON_PREFIX not in reason:
                capture_reason = CAPTURE_REASON_PREFIX + "; ".join(
                    capture.reasons or ["record a complete side-on shot"]
                )
                reason = "; ".join(filter(None, [reason, capture_reason]))
            metric = _unavailable(metric, reason)
        metrics.append(metric)
    quality = analysis_quality(metrics, result.phases, capture)
    return result.model_copy(update={
        "capture_quality": capture,
        "metrics": metrics,
        "quality": quality,
        "similarity_score": (
            None if quality.status == "insufficient" else compare.similarity_score(metrics)
        ),
        "form_score": compare.similarity_score(metrics, "form"),
        "timing_score": compare.similarity_score(metrics, "timing"),
        "feedback": feedback.rank(metrics),
    })


def build_comparison(
    base: AnalysisResult,
    template: BenchmarkProfile,
    player_metrics: dict[str, float],
    evidence: MeasurementEvidence,
) -> AnalysisResult:
    """Compare raw measurements, then derive eligible scores and feedback once."""
    deltas = compare.metric_deltas(player_metrics, template, evidence)
    result = base.model_copy(update={
        "benchmark_version": template.version,
        "template_id": template.version,
        "template_name": template.display_name or template.version,
        "timing_mode": template.timing_mode,
        "timing_reliable": template.timing_reliable,
        "metrics": deltas,
        "measurement_evidence": evidence,
        "benchmark_sequence": None,
        "benchmark_phases": template.canonical_phases,
    })
    return apply_comparison_policy(result)
