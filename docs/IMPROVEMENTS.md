# OneMotion improvement ledger

Implementation started 2026-09-05 on the existing working tree. Existing edits
were preserved. The rows distinguish implemented code from external validation
or rollout work; they do not claim a completed production rollout.

| Task | State | Implementation / verification |
| --- | --- | --- |
| 01 Naming | Repository updated | OneMotion / onemotion / ONEMOTION throughout source, docs, environment examples, package metadata, locks and Docker definitions. CI checks spelling. Local workspace directory and existing container names require a separate operational migration. |
| 02 Repeated comparison | Implemented, tested | Preserve raw measurement evidence; legacy fallback keeps prior reliability. First/repeated scores, metrics and feedback agree. |
| 03 Metric dependencies | Implemented, tested | Load/lift/release and scale/neighbor evidence propagate; benchmark aggregation uses the same gate. |
| 04 Input/resource limits | Implemented, tested | Browser size/metadata checks; server preflight, frame/time/pixel budgets, finite inference slots and 429 responses. Native calls use cooperative timeout checks. |
| 05 Storage integrity | Implemented, tested | Unique atomic temporaries, advisory locks, rollback, aged orphan cleanup, concurrent legacy migration. |
| 06 Capture lifecycle | Implemented, browser-tested | Late permission stops tracks; pending/recording states and cleanup prevent duplicate captures; submitted file is locked. |
| 07 Clean deployment | Images built | Optional public directory handled; all data directories probed; preparation/UID instructions supplied. Running service rollout is separate. |
| 08 Benchmark provenance | Implemented, exercised | Explicit source hashes/interval/speed; registry preserves metadata; separate release pinning. Real reference rebuilt and released in isolated storage. Active local release is retained. |
| 09 Expiry/recovery | Implemented, tested | Video/replay expiry agrees; inline legacy poses removed on expiry; 404/410/service/network recovery UI. |
| 10 Replay controls | Implemented, browser-tested | Pixel-space arcs, independent stop boundary, immediate paused-overlay redraw. |
| 11 Regression/CI | Local checks passed | Backend regression suite, Playwright capture/upload/report/replay checks, route types, lint and both container builds. GitHub execution awaits pushing changes. |
| 12 Evaluation | Runner implemented; labels pending | Frozen-case hashes, annotation-source separation, phase/metric/feedback checks and latency. Two local baseline cases pass; independent human labels remain necessary for accuracy claims. |

Reproduction commands and limits live in the root README and EVALUATION.md.
Existing reference videos, model weights and player data were not replaced.

Local verification: 34 backend tests and 9 browser tests passed; lint, generated
route types/TypeScript, branding and whitespace checks passed. Both final Docker
images built successfully. The isolated real-reference API round trip returned
90 pose frames, preserved comparison metrics, served a 206 media range, and
completed deletion. Analysis took 2.43 seconds for that one 3-second clip on this
host; this is not a general latency guarantee. Two local frozen baseline cases
passed with zero human-labeled cases.
