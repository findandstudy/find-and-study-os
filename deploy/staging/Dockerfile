# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE="node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e"

FROM ${NODE_IMAGE} AS build
ARG APP_UID=10042
ARG APP_GID=10042
ARG FASOS_SOURCE_COMMIT

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git build-essential python3 \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@10.33.2 --activate \
  && groupadd --gid "${APP_GID}" findandstudy \
  && useradd --uid "${APP_UID}" --gid "${APP_GID}" --create-home \
       --shell /usr/sbin/nologin findandstudy

WORKDIR /workspace
COPY --chown=${APP_UID}:${APP_GID} . .
RUN chown "${APP_UID}:${APP_GID}" /workspace
USER findandstudy

RUN test -n "${FASOS_SOURCE_COMMIT}" \
  && test "$(git rev-parse --verify HEAD)" = "${FASOS_SOURCE_COMMIT}" \
  && test -z "$(git status --porcelain=v1 --untracked-files=no)"
RUN pnpm install --frozen-lockfile
RUN SKIP_PLAYWRIGHT_BROWSER_CHECK=1 pnpm run build:prod
RUN node lib/db/validate-migrations.mjs

FROM ${NODE_IMAGE} AS runtime
ENV COREPACK_HOME=/usr/local/share/corepack
ARG APP_UID=10042
ARG APP_GID=10042
RUN install -d -o root -g root -m 0755 "${COREPACK_HOME}" \
  && corepack enable \
  && corepack prepare pnpm@10.33.2 --activate \
  && test "$(pnpm --version)" = "10.33.2" \
  && groupadd --gid "${APP_GID}" findandstudy \
  && useradd --uid "${APP_UID}" --gid "${APP_GID}" --create-home \
       --shell /usr/sbin/nologin findandstudy \
  && install -d -o "${APP_UID}" -g "${APP_GID}" -m 0750 /app
COPY --from=build --chown=${APP_UID}:${APP_GID} /workspace /app
RUN rm -rf /app/.git /app/.github /app/test-results /app/playwright-report

WORKDIR /app
ENV NODE_ENV=production \
    PORT=5000
USER findandstudy
EXPOSE 5000
CMD ["node", "artifacts/api-server/dist/index.cjs"]
