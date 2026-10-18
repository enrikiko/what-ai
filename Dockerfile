FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=80

COPY package.json ./
COPY src ./src
COPY MODEL_REPLY_RULES.md ./MODEL_REPLY_RULES.md

RUN mkdir -p /app/logs && chown -R node:node /app
USER node

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]
