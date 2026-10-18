FROM node:22-alpine

RUN apk add --no-cache su-exec

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=80

COPY package.json ./
COPY src ./src
COPY MODEL_REPLY_RULES.md ./MODEL_REPLY_RULES.md
COPY docker-entrypoint.sh ./docker-entrypoint.sh

RUN mkdir -p /app/logs /app/contexts && chmod +x /app/docker-entrypoint.sh
USER root

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["/app/docker-entrypoint.sh"]
