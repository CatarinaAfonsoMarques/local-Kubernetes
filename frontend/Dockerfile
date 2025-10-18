# syntax=docker/dockerfile:1
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN set -eux; \
    if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev; \
    fi

COPY . .
EXPOSE 3000
USER node
CMD ["node", "server.js"]