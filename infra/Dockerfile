FROM node:26.5.0-bookworm-slim AS build
RUN npm install --global pnpm@9.15.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/web ./apps/web
COPY config ./config
COPY scripts/sim-build.ts ./scripts/sim-build.ts
RUN pnpm install --frozen-lockfile --filter "@gaffer/api..." && pnpm --filter @gaffer/api build
RUN mkdir /manifests && cp --parents package.json pnpm-lock.yaml pnpm-workspace.yaml packages/*/package.json apps/api/package.json /manifests/

FROM node:26.5.0-bookworm-slim
RUN npm install --global pnpm@9.15.0
ARG BUILD_ID=local
ENV GAFFER_BUILD_ID=$BUILD_ID
WORKDIR /app
COPY --from=build /manifests ./
# The bundles import npm packages by name; a hoisted tree lets the workspace packages' own
# dependencies resolve from /app/node_modules as well.
RUN pnpm install --frozen-lockfile --prod --config.node-linker=hoisted --filter "@gaffer/api..."
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY config ./config
COPY infra/migrations ./infra/migrations
ENV NODE_ENV=production GAFFER_MODE=production GAFFER_DATA_DIR=/tmp/gaffer-runtime PORT=8080
USER node
EXPOSE 8080
CMD ["node", "apps/api/dist/main.mjs"]
