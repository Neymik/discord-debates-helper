# Build stage
FROM node:20-alpine AS build
WORKDIR /app
# Native modules (@discordjs/opus, libsodium-wrappers) need a toolchain.
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/discord-bot/package.json packages/discord-bot/
RUN npm ci
COPY packages/shared packages/shared
COPY packages/discord-bot packages/discord-bot
RUN npm run build -w @debates/shared && npm run build -w @debates/discord-bot

# Runtime stage
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/discord-bot/package.json packages/discord-bot/
# Rebuild native deps in the runtime image, then drop the toolchain.
RUN apk add --no-cache --virtual .build python3 make g++ \
 && npm ci --omit=dev \
 && apk del .build
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/discord-bot/dist packages/discord-bot/dist
CMD ["npm", "run", "start", "-w", "@debates/discord-bot"]
