FROM node:24-alpine AS builder
WORKDIR /app
# Build context is repo root, so reference api-server/ paths explicitly
COPY api-server/package*.json ./
RUN npm ci
COPY api-server/src/ ./src/
COPY api-server/tsconfig.json ./
RUN npm run build

FROM node:24-alpine
WORKDIR /app
COPY api-server/package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/build ./build
EXPOSE 8080
CMD ["node", "build/index.js"]
