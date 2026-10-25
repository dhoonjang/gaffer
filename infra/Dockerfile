FROM node:26.5.0-bookworm-slim
RUN npm install --global pnpm@9.15.0
ARG BUILD_ID=local
ENV GAFFER_BUILD_ID=$BUILD_ID
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/web ./apps/web
COPY config ./config
COPY tsconfig.json ./
COPY scripts/sim-build.ts ./scripts/sim-build.ts
COPY infra/migrations ./infra/migrations
RUN pnpm install --frozen-lockfile --prod
ENV NODE_ENV=production GAFFER_MODE=production GAFFER_DATA_DIR=/tmp/gaffer-runtime PORT=8080
USER node
EXPOSE 8080
CMD ["pnpm", "--filter", "@gaffer/api", "start"]
