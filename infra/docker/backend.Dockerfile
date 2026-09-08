FROM python:3.13-slim AS builder

COPY --from=ghcr.io/astral-sh/uv:0.11.6 /uv /uvx /bin/
WORKDIR /srv/backend
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

FROM python:3.13-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/srv/backend/.venv/bin:$PATH"
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 onemotion \
    && useradd --uid 10001 --gid onemotion --create-home onemotion

WORKDIR /srv/backend
COPY --from=builder /srv/backend/.venv ./.venv
COPY --chown=onemotion:onemotion backend/app ./app

# The pose model, curry_v3 benchmark, reference clip, and their checksum manifest
# (infra/artifacts.json) are local-only and gitignored — they are never baked
# into the image. compose.yaml bind-mounts all four at runtime; /ready reports
# 503 until they are present. ONEMOTION_ARTIFACT_MANIFEST points at the mount.
RUN mkdir -p /srv/infra && chown onemotion:onemotion /srv/infra

USER onemotion
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--proxy-headers"]
