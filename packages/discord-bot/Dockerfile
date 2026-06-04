# Build stage — Debian (glibc) + Node 22.
# @discordjs/voice@0.19 needs Node >=22.12; @discordjs/opus's libopus fails to
# compile under Alpine's GCC 15 (-Wincompatible-pointer-types is a hard error
# in GCC 14+), so we use Debian bookworm (GCC 12) which compiles it cleanly.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/discord-bot/package.json packages/discord-bot/
RUN npm ci
COPY packages/shared packages/shared
COPY packages/discord-bot packages/discord-bot
RUN npm run build -w @debates/shared && npm run build -w @debates/discord-bot

# Runtime stage
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/discord-bot/package.json packages/discord-bot/
# Build toolchain only long enough to compile native deps for the prod install, then remove it.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && npm ci --omit=dev \
 && apt-get purge -y python3 make g++ && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/discord-bot/dist packages/discord-bot/dist
CMD ["npm", "run", "start", "-w", "@debates/discord-bot"]
