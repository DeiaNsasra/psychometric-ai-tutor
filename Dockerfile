# Build stage: better-sqlite3 may need compiling, which needs python/make/g++.
FROM node:20-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-slim
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server.js accounts.js db.js system-prompt.md index.json dictionary-index.json ./
COPY public ./public
COPY materials ./materials
COPY rendered ./rendered
ENV HOST=0.0.0.0 PORT=8080 NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
