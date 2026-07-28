# syntax=docker/dockerfile:1.7

# Single image, shared by both the `web` and `worker` compose services (only
# the command differs) — "worker startet aus derselben gebauten Anwendung".

FROM node:22.12.0-alpine AS base
RUN npm install -g pnpm@9.15.0

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build
RUN pnpm build:worker
RUN pnpm build:migrate

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S adloop && adduser -S adloop -G adloop

# Next.js standalone server (traced production deps + minimal server code).
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

# Worker and migration runner: fully self-contained bundles (esbuild, no
# --packages=external) — they run in the same image but are never traced by
# Next's standalone output, so they carry their own dependency closure
# instead of relying on node_modules being complete for them too.
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations

USER adloop
EXPOSE 3000
CMD ["node", "server.js"]
