"""Evaluate frozen pose cases without downloading a model or inventing labels.

Manifest cases specify sequence, sha256, label_source (human/synthetic/baseline),
expected_phases_ms, expected_unreliable, and optional expected_metrics and
expected_feedback. Only human labels support accuracy claims; other cases are
regression fixtures. Model inference latency must be measured separately.
"""

import argparse
import json
import sys
import time
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.analysis.compare import metric_deltas
from app.analysis.feedback import rank
from app.analysis.metrics import compute_all, measurement_evidence
from app.analysis.phases import segment
from app.benchmarks.curry import load_benchmark
from app.benchmarks.provenance import file_sha256
from app.core.storage import atomic_write
from app.schemas.pose import ShotSequence


def evaluate(manifest_path: Path, tolerance_ms: float = 100) -> dict:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not manifest.get("cases"):
        raise ValueError("evaluation requires at least one explicitly labeled case")
    root = manifest_path.parent
    benchmark = load_benchmark(root / manifest["benchmark"]) if manifest.get("benchmark") else None
    results = []
    for case in manifest["cases"]:
        source = case.get("label_source")
        if source not in {"human", "synthetic", "baseline"}:
            raise ValueError("label_source must identify human, synthetic, or baseline labels")
        path = root / case["sequence"]
        if file_sha256(path) != case["sha256"]:
            raise ValueError(f"evaluation sequence changed: {case['id']}")
        seq = ShotSequence.model_validate_json(path.read_text(encoding="utf-8"))
        started = time.perf_counter()
        phases = segment(seq)
        metrics = compute_all(seq, phases)
        evidence = measurement_evidence(seq, phases)
        cues = rank(metric_deltas(metrics, benchmark, evidence)) if benchmark else []
        elapsed = (time.perf_counter() - started) * 1000
        anchors = {p.phase: seq.frames[p.anchor_frame if p.anchor_frame is not None else p.start_frame].t_ms for p in phases}
        errors = {phase: abs(anchors[phase] - expected) for phase, expected in case.get("expected_phases_ms", {}).items()}
        false_reliable = [name for name in case.get("expected_unreliable", []) if evidence.get(name, {}).get("reliable")]
        metric_errors = {name: abs(metrics[name] - expected["value"]) if name in metrics else None
                         for name, expected in case.get("expected_metrics", {}).items()}
        metric_pass = all(error is not None and error <= case["expected_metrics"][name]["tolerance"] for name, error in metric_errors.items())
        feedback_match = None
        if "expected_feedback" in case:
            if benchmark is None:
                raise ValueError("feedback labels require a benchmark")
            feedback_match = (cues[0].metric if cues else None) == case["expected_feedback"]
        passed = not false_reliable and all(error <= tolerance_ms for error in errors.values()) and metric_pass and feedback_match is not False
        results.append({"id": case["id"], "label_source": source, "tags": case.get("tags", []),
                        "passed": passed, "phase_error_ms": errors, "false_reliable_metrics": false_reliable,
                        "metric_absolute_error": metric_errors, "feedback_match": feedback_match,
                        "reliable_metric_count": sum(bool(v["reliable"]) for v in evidence.values()),
                        "analysis_latency_ms": round(elapsed, 3)})
    groups = defaultdict(list)
    for result in results:
        groups[result["label_source"]].append(result)
    return {"case_count": len(results), "passed": all(r["passed"] for r in results),
            "human_labeled_count": len(groups["human"]),
            "by_label_source": {source: {"count": len(items), "passing": sum(r["passed"] for r in items)} for source, items in groups.items()},
            "cases": results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--phase-tolerance-ms", type=float, default=100)
    args = parser.parse_args()
    if args.phase_tolerance_ms < 0:
        parser.error("phase tolerance cannot be negative")
    result = evaluate(args.manifest, args.phase_tolerance_ms)
    atomic_write(args.output, json.dumps(result, indent=2) + "\n")
    print(f"{result['case_count']} cases; {result['human_labeled_count']} human-labeled; passed={result['passed']}")
    raise SystemExit(0 if result["passed"] else 1)


if __name__ == "__main__":
    main()
