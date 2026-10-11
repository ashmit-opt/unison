# Single-process image: static PWA + room API + WebSocket relay. TLS is terminated by the platform/proxy.
FROM oven/bun:1.2.6-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN mkdir -p /data && chown bun:bun /data
ENV NODE_ENV=production PORT=8080 METRICS_FILE=/data/metrics.jsonl
EXPOSE 8080
USER bun
HEALTHCHECK CMD wget -qO- http://localhost:8080/healthz || exit 1
CMD ["bun", "src/server/server.ts"]
