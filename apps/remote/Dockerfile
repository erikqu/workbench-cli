FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
COPY services ./services
COPY src/discovery.ts src/shared.ts ./src/
COPY scripts/build-services.mjs ./scripts/build-services.mjs
RUN npm run build:services && npm prune --omit=dev --omit=optional

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production BIND_ADDRESS=0.0.0.0 PORT=8080
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist/services ./dist/services
COPY --chown=node:node public ./public
USER node
EXPOSE 8080
CMD ["node", "dist/services/relay/main.mjs"]
