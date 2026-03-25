FROM node:24-alpine AS builder
WORKDIR /app
# Copy root workspace manifests — the canonical lock file lives at the monorepo root
COPY package*.json ./
COPY api-server/package*.json ./api-server/
# Install only api-server workspace deps (skips client)
RUN npm ci --workspace=api-server
COPY api-server/ ./api-server/
RUN npm run build --workspace=api-server

FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
COPY api-server/package*.json ./api-server/
RUN npm ci --workspace=api-server --omit=dev
COPY --from=builder /app/api-server/build ./build
EXPOSE 8080
CMD ["node", "build/index.js"]
