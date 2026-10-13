"""Persistent training contracts and failure cases without media or models."""

import copy
import json
import multiprocessing
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings, get_settings
from app.core.retention import cleanup_expired
from app.main import create_app
from app.schemas.training import TrainingSessionCreate
from app.training import store

ENDPOINT = "/api/v1/training/sessions"


@pytest.fixture
def cfg(tmp_path):
    return Settings(data_dir=tmp_path)


@pytest.fixture
def client(cfg):
    app = create_app()
    app.dependency_overrides[get_settings] = lambda: cfg
    with TestClient(app) as result:
        yield result


def payload(**updates):
    body = {
        "session_id": str(uuid4()),
        "drill_id": "close-form",
        "started_at": "2026-10-05T09:00:00+08:00",
        "completed_at": "2026-10-05T09:02:03.456+08:00",
        "planned_sets": 2,
        "planned_reps": 3,
        "sets": [{"attempts": [True, False, True]}, {"attempts": [False, True, False]}],
        "status": "completed",
    }
    body.update(updates)
    return body


def test_empty_history_is_explicit(client, cfg):
    response = client.get(ENDPOINT)
    assert response.status_code == 200
    assert response.json() == {
        "sessions": [], "has_more": False,
        "summary": {"sessions": 0, "completed_sessions": 0, "attempts": 0,
                    "makes": 0, "accuracy_pct": None, "duration_ms": 0},
    }
    assert not cfg.training_sessions_dir.exists()


def test_create_derived_totals_and_restart_persistence(client, cfg):
    body = payload()
    response = client.post(ENDPOINT, json=body)
    assert response.status_code == 201
    saved = response.json()
    assert saved["started_at"] == "2026-10-05T01:00:00Z"
    assert saved["completed_at"] == "2026-10-05T01:02:03.456000Z"
    assert saved["totals"] == {
        "attempts": 6, "makes": 3, "accuracy_pct": 50.0,
        "duration_ms": 123456, "completed_sets": 2,
    }
    path = cfg.training_sessions_dir / f"{body['session_id']}.json"
    assert json.loads(path.read_text(encoding="utf-8")) == saved
    another_app = create_app()
    another_app.dependency_overrides[get_settings] = lambda: cfg
    with TestClient(another_app) as restarted:
        assert restarted.get(ENDPOINT).json()["sessions"] == [saved]


def test_retry_normalizes_uuid_and_clocks_but_preserves_first_response(client, cfg):
    body = payload()
    first = client.post(ENDPOINT, json=body)
    equivalent = copy.deepcopy(body)
    equivalent["session_id"] = body["session_id"].upper()
    equivalent["started_at"] = "2026-10-05T01:00:00Z"
    equivalent["completed_at"] = "2026-10-05T01:02:03.456Z"
    repeated = client.post(ENDPOINT, json=equivalent)
    assert repeated.status_code == 200
    assert repeated.json() == first.json()
    assert len(list(cfg.training_sessions_dir.glob("*.json"))) == 1


@pytest.mark.parametrize("change", [
    {"drill_id": "guide-hand"},
    {"status": "partial"},
    {"completed_at": "2026-10-05T09:02:04+08:00"},
    {"sets": [{"attempts": [False, False, True]}, {"attempts": [False, True, False]}]},
])
def test_uuid_conflicts_never_overwrite_saved_outcomes(client, change):
    body = payload()
    first = client.post(ENDPOINT, json=body).json()
    conflicting = {**body, **change}
    result = client.post(ENDPOINT, json=conflicting)
    assert result.status_code == 409
    assert isinstance(result.json()["detail"], str)
    assert client.get(ENDPOINT).json()["sessions"] == [first]


def test_partial_and_empty_outcomes_are_derived_not_assumed(client):
    partial = payload(status="partial", sets=[{"attempts": [True, True, False]}, {"attempts": [False]}])
    result = client.post(ENDPOINT, json=partial)
    assert result.status_code == 201
    assert result.json()["totals"] == {
        "attempts": 4, "makes": 2, "accuracy_pct": 50.0,
        "duration_ms": 123456, "completed_sets": 1,
    }
    empty = payload(status="partial", sets=[], completed_at="2026-10-05T09:00:00+08:00")
    result = client.post(ENDPOINT, json=empty)
    assert result.status_code == 201
    assert result.json()["totals"] == {
        "attempts": 0, "makes": 0, "accuracy_pct": None,
        "duration_ms": 0, "completed_sets": 0,
    }


def test_history_summary_counts_all_records_and_weights_every_shot(client):
    first = payload(status="completed", planned_sets=1, planned_reps=2,
                    sets=[{"attempts": [True, True]}])
    second = payload(status="partial", sets=[{"attempts": [False]}],
                     completed_at="2026-10-05T09:04:00+08:00")
    client.post(ENDPOINT, json=first)
    client.post(ENDPOINT, json=second)
    result = client.get(ENDPOINT, params={"limit": 1})
    assert result.status_code == 200
    data = result.json()
    assert [item["session_id"] for item in data["sessions"]] == [second["session_id"]]
    assert data["has_more"] is True
    assert data["summary"] == {
        "sessions": 2, "completed_sessions": 1, "attempts": 3, "makes": 2,
        "accuracy_pct": pytest.approx(200 / 3), "duration_ms": 123456 + 240000,
    }


def test_maximum_valid_plan_and_seven_day_clock(client):
    result = client.post(ENDPOINT, json=payload(
        planned_sets=20, planned_reps=100,
        sets=[{"attempts": [True] * 100} for _ in range(20)],
        completed_at="2026-10-12T09:00:00+08:00",
    ))
    assert result.status_code == 201
    assert result.json()["totals"] == {
        "attempts": 2000, "makes": 2000, "accuracy_pct": 100.0,
        "duration_ms": 604800000, "completed_sets": 20,
    }


@pytest.mark.parametrize("change", [
    {"session_id": "../../report"},
    {"session_id": "00000000-0000-1000-8000-000000000000"},
    {"session_id": True},
    {"drill_id": "unknown-drill"},
    {"drill_id": "close-form "},
    {"planned_sets": True}, {"planned_sets": "2"}, {"planned_sets": 2.0},
    {"planned_sets": 0}, {"planned_sets": 21},
    {"planned_reps": False}, {"planned_reps": "3"}, {"planned_reps": 101},
    {"sets": [{"attempts": [True] * 101}]},
    {"sets": [{"attempts": [True]} for _ in range(21)]},
    {"sets": [{"attempts": [True, 1, False]}]},
    {"sets": [{"attempts": [True, "false", False]}]},
    {"sets": [{"attempts": [True, None, False]}]},
    {"sets": [{"attempts": [True, False, True], "makes": 3}]},
    {"sets": [{"attempts": [True, False, True]}]},
    {"sets": [{"attempts": []}, {"attempts": [True]}], "status": "partial"},
    {"sets": [{"attempts": [True]}, {"attempts": [True]}], "status": "partial"},
    {"planned_sets": 1}, {"planned_reps": 2},
    {"status": "aborted"},
    {"started_at": "2026-10-05T09:00:00"},
    {"started_at": 1791158400}, {"completed_at": True},
    {"started_at": "0001-01-01T00:00:00+14:00"},
    {"completed_at": "9999-12-31T23:59:59-14:00"},
    {"completed_at": "2026-10-05T08:59:59.999999+08:00"},
    {"completed_at": "2026-10-12T09:00:00.000001+08:00"},
    {"started_at": "x" * 65},
    {"totals": {"attempts": 999, "makes": 999}},
    {"makes": 999}, {"duration_ms": 1}, {"analysis_id": "a" * 32},
])
def test_untrusted_request_boundaries_return_string_422_without_writes(client, cfg, change):
    result = client.post(ENDPOINT, json=payload(**change))
    assert result.status_code == 422, result.text
    assert isinstance(result.json()["detail"], str)
    assert not list(cfg.training_sessions_dir.glob("*.json"))


@pytest.mark.parametrize("limit", ["0", "101", "-1", "many", "1.5"])
def test_history_limit_is_bounded(client, limit):
    result = client.get(ENDPOINT, params={"limit": limit})
    assert result.status_code == 422
    assert isinstance(result.json()["detail"], str)


def test_default_history_is_capped_at_100_with_complete_summary(cfg):
    for index in range(102):
        body = payload(planned_sets=1, planned_reps=1, sets=[{"attempts": [True]}])
        body["completed_at"] = (datetime(2026, 10, 5, 1, 0, tzinfo=timezone.utc) + timedelta(seconds=index)).isoformat()
        store.create_session(cfg, TrainingSessionCreate.model_validate(body))
    result = store.list_sessions(cfg)
    assert len(result.sessions) == 100
    assert result.has_more is True
    assert result.summary.sessions == result.summary.attempts == result.summary.makes == 102
    assert result.sessions[0].completed_at > result.sessions[-1].completed_at


def test_same_uuid_concurrent_requests_create_one_immutable_record(cfg):
    request = TrainingSessionCreate.model_validate(payload())
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: store.create_session(cfg, request), range(16)))
    assert sum(created for _, created in results) == 1
    assert all(record == results[0][0] for record, _ in results)
    assert len(list(cfg.training_sessions_dir.glob("*.json"))) == 1


def _process_create(data_dir, body, start, results):
    try:
        start.wait(timeout=10)
        record, created = store.create_session(Settings(data_dir=data_dir), TrainingSessionCreate.model_validate(body))
        results.put((created, record.model_dump_json()))
    except Exception as exc:
        results.put(("error", repr(exc)))


def test_uuid_lock_serializes_separate_processes(cfg):
    context = multiprocessing.get_context("spawn")
    start, results = context.Event(), context.Queue()
    body = payload()
    workers = [context.Process(target=_process_create, args=(str(cfg.data_dir), body, start, results)) for _ in range(2)]
    try:
        for worker in workers:
            worker.start()
        start.set()
        responses = [results.get(timeout=15) for _ in workers]
        for worker in workers:
            worker.join(timeout=15)
            assert worker.exitcode == 0
        assert sorted(created for created, _ in responses) == [False, True]
        assert responses[0][1] == responses[1][1]
    finally:
        for worker in workers:
            if worker.is_alive():
                worker.terminate()
                worker.join(timeout=5)
        results.close()


def test_write_failure_is_retryable_and_leaves_no_successful_record(client, cfg, monkeypatch):
    real_write = store.atomic_write
    body = payload()
    monkeypatch.setattr(store, "atomic_write", lambda *_: (_ for _ in ()).throw(OSError("private filesystem details")))
    result = client.post(ENDPOINT, json=body)
    assert result.status_code == 503
    assert result.headers["retry-after"] == "5"
    assert result.json() == {"detail": "training storage is unavailable"}
    assert not list(cfg.training_sessions_dir.glob("*.json"))
    monkeypatch.setattr(store, "atomic_write", real_write)
    assert client.post(ENDPOINT, json=body).status_code == 201


def test_storage_directory_is_a_file_returns_503_on_save_and_history(client, cfg):
    cfg.training_sessions_dir.parent.mkdir(parents=True)
    cfg.training_sessions_dir.write_text("not a directory", encoding="utf-8")
    for result in (client.post(ENDPOINT, json=payload()), client.get(ENDPOINT)):
        assert result.status_code == 503
        assert result.json() == {"detail": "training storage is unavailable"}


def test_unreadable_history_is_an_error_instead_of_an_empty_success(client, monkeypatch):
    monkeypatch.setattr(store.os, "scandir", lambda *_: (_ for _ in ()).throw(PermissionError("private directory")))
    result = client.get(ENDPOINT)
    assert result.status_code == 503
    assert result.json() == {"detail": "training storage is unavailable"}


@pytest.mark.parametrize("corruption", ["invalid json", "wrong totals", "wrong id"])
def test_corrupt_saved_record_is_not_silently_omitted_or_overwritten(client, cfg, corruption):
    body = payload()
    original = client.post(ENDPOINT, json=body).json()
    path = cfg.training_sessions_dir / f"{body['session_id']}.json"
    if corruption == "invalid json":
        path.write_text("{bad", encoding="utf-8")
    else:
        changed = copy.deepcopy(original)
        if corruption == "wrong totals":
            changed["totals"]["makes"] = 6
        else:
            changed["session_id"] = str(uuid4())
        path.write_text(json.dumps(changed), encoding="utf-8")
    before = path.read_bytes()
    assert client.get(ENDPOINT).status_code == 503
    assert client.post(ENDPOINT, json=body).status_code == 503
    assert path.read_bytes() == before


def test_history_ignores_atomic_write_temporary_files(client, cfg):
    cfg.training_sessions_dir.mkdir(parents=True)
    (cfg.training_sessions_dir / "session.json.in-progress.tmp").write_text("{incomplete", encoding="utf-8")
    assert client.get(ENDPOINT).json()["summary"]["sessions"] == 0


def test_retention_never_expires_manual_training_records(client, cfg):
    body = payload(started_at="2020-01-01T01:00:00Z", completed_at="2020-01-01T01:01:00Z")
    saved = client.post(ENDPOINT, json=body).json()
    cleanup_expired(cfg)
    assert client.get(ENDPOINT).json()["sessions"] == [saved]
