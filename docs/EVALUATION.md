# OneMotion evaluation

The runner separates human annotations from synthetic and frozen-baseline
regressions. Passing a baseline case does not demonstrate coaching accuracy.
No independently human-labeled evaluation dataset is currently checked in.

From `backend`:

```bash
uv run python scripts/evaluate.py /path/to/evaluation/manifest.json \
  --output /path/to/results.json --phase-tolerance-ms 100
uv run python scripts/smoke_analysis.py --output /tmp/onemotion-api-smoke.json
```

The smoke command copies the configured model, benchmark, manifest and reference
into temporary storage, runs real inference, checks repeated comparison, skeleton
replay, media range requests and deletion, then removes its temporary artifacts.
It does not analyze or delete existing player uploads. Its latency includes pose
inference and request processing. The frozen-pose evaluator's latency excludes
pose inference and must not be reported as end-to-end model performance.

## Manifest contract

```json
{
  "benchmark": "../benchmarks/curry_v3.json",
  "cases": [{
    "id": "annotated-shot-001",
    "sequence": "shot-001.json",
    "sha256": "REPLACE_WITH_THE_SEQUENCE_SHA256",
    "label_source": "human",
    "tags": ["right-handed", "side-view", "30fps"],
    "expected_phases_ms": {"load": 300, "release": 1100},
    "expected_unreliable": [],
    "expected_metrics": {"shot_tempo_s": {"value": 0.8, "tolerance": 0.1}},
    "expected_feedback": "shot_tempo_s"
  }]
}
```

The numbers above illustrate the format; they are not labels for actual footage.
Paths resolve relative to the manifest. `benchmark` is optional unless feedback
is labeled. `label_source` is required and is `human`, `synthetic` or `baseline`.
Only include expected values that were actually annotated. Sequence checksums
prevent silently replacing cases. A run fails on phase/metric tolerance misses,
false reliable measurements or mismatched labeled feedback.

## Remaining dataset work

Collect approved footage spanning both shooting hands, 30/60/120 fps, side and
oblique views, partial occlusion, clipped dip/follow-through, and varied body
sizes/clothing. Annotators should identify phase anchors independently of the
algorithm; a second reviewer should resolve disagreements. Record annotation
provenance and split by player/source video so train and evaluation data do not
share near-duplicate shots. Source media remains local until distribution rights
are established.

Report phase error distributions, reliable-metric coverage, error on labeled
measurements, false reliability under occlusion and top-1 feedback agreement.
Measure full inference latency on declared hardware separately. Compare models
on exactly the same frozen cases and publish results by annotation source and
capture condition. Validate the PRD's accuracy targets only against human labels.
