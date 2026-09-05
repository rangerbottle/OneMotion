"""Aggregates all /api/v1 routers."""

from fastapi import APIRouter

from app.api import routes_analysis, routes_benchmarks, routes_pose, routes_templates

api_router = APIRouter()
api_router.include_router(routes_pose.router, tags=["pose"])
api_router.include_router(routes_analysis.router, tags=["analysis"])
api_router.include_router(routes_benchmarks.router, tags=["benchmarks"])
api_router.include_router(routes_templates.router, tags=["templates"])
