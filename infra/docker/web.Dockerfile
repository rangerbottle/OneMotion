FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ARG NEXT_PUBLIC_API_BASE=""
ENV NEXT_PUBLIC_API_BASE=$NEXT_PUBLIC_API_BASE
COPY --from=dependencies /app/node_modules ./node_modules
COPY apps/web ./
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
RUN groupadd --gid 10001 onmotion \
    && useradd --uid 10001 --gid onmotion --create-home onmotion
COPY --from=builder --chown=onmotion:onmotion /app/.next/standalone ./
COPY --from=builder --chown=onmotion:onmotion /app/.next/static ./.next/static
COPY --from=builder --chown=onmotion:onmotion /app/public ./public
USER onmotion
EXPOSE 3000
CMD ["node", "server.js"]
