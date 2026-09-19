"""Benchmark profile endpoints."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException

from app.benchmarks.curry import load_benchmark
from app.core.config import Settings, get_settings
from app.schemas.benchmark import BenchmarkProfile

router = APIRouter()


@router.get("/benchmarks/current", response_model=BenchmarkProfile)
def current_benchmark(
    cfg: Annotated[Settings, Depends(get_settings)],
) -> BenchmarkProfile:
    """Return the current Curry benchmark profile.

    The canonical pose sequence (used for skeleton overlay replay) is large,
    so it is omitted from this response.
    """
    try:
        profile = load_benchmark(cfg.benchmark_path)
    except FileNotFoundError:
        raise HTTPException(
            404,
            "No Curry benchmark yet — run backend/scripts/build_curry_benchmark.py",
        )
    except (ValueError, KeyError) as exc:
        raise HTTPException(503, f"benchmark profile is unreadable: {exc}")
    return profile.model_copy(update={"canonical_sequence": None})
