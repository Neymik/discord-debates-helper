# Build stage
FROM node:20-alpine AS build
WORKDIR /app
# Prisma's engines on Alpine (musl) need openssl + libc6-compat to load; without
# them the schema/query engine fails with "Could not parse schema engine response".
RUN apk add --no-cache openssl libc6-compat
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
RUN npm ci --ignore-scripts
COPY packages/shared packages/shared
COPY packages/api packages/api
RUN npx prisma generate --schema packages/api/prisma/schema.prisma
RUN npm run build -w @debates/shared && npm run build -w @debates/api

# Runtime stage
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Same Prisma runtime requirement as the build stage (migrate deploy at boot).
RUN apk add --no-cache openssl libc6-compat
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/api/dist packages/api/dist
COPY --from=build /app/packages/api/prisma packages/api/prisma
COPY --from=build /app/node_modules/.prisma node_modules/.prisma
# The prisma CLI is a devDependency, so `npm ci --omit=dev` does not install it.
# `npm run prisma:migrate` (= `prisma migrate deploy`) needs it at boot, so copy
# the CLI and its deps from the build stage where dev deps were installed.
COPY --from=build /app/node_modules/prisma node_modules/prisma
COPY --from=build /app/node_modules/@prisma node_modules/@prisma
EXPOSE 3000
CMD ["sh", "-c", "npm run prisma:migrate -w @debates/api && npm run start -w @debates/api"]
