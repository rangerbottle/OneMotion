"""FastAPI application factory and entry point."""

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.router import api_router
from app.api.routes_health import router as health_router


def create_app() -> FastAPI:
    from app.core.config import settings, get_settings

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        from app.core.retention import cleanup_expired

        cfg = application.dependency_overrides.get(get_settings, get_settings)()
        cleanup_expired(cfg)
        if cfg.warm_model:
            from app.pose import get_backend

            get_backend(cfg)

        async def retention_loop() -> None:
            while True:
                await asyncio.sleep(15 * 60)
                try:
                    await asyncio.to_thread(cleanup_expired, cfg)
                except Exception:
                    logging.getLogger(__name__).exception("Media cleanup failed; retrying next sweep")

        retention_task = asyncio.create_task(retention_loop())
        try:
            yield
        finally:
            retention_task.cancel()
            try:
                await retention_task
            except asyncio.CancelledError:
                pass

    app = FastAPI(title="OneMotion API", version="0.2.0", lifespan=lifespan)

    # Player app dev server runs on localhost:3000.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            origin.strip()
            for origin in settings.allowed_origins.split(",")
            if origin.strip()
        ],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(health_router)
    app.include_router(api_router, prefix="/api/v1")
    return app


app = create_app()
