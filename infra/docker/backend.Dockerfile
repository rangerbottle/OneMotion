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
    && groupadd --gid 10001 onmotion \
    && useradd --uid 10001 --gid onmotion --create-home onmotion

WORKDIR /srv/backend
COPY --from=builder /srv/backend/.venv ./.venv
COPY --chown=onmotion:onmotion backend/app ./app
COPY --chown=onmotion:onmotion infra/artifacts.json /srv/infra/artifacts.json

USER onmotion
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--proxy-headers"]
