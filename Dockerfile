FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY assets ./assets
COPY index.js ./

RUN mkdir -p /app/data && chmod 777 /app/data

ENV NODE_ENV=production
ENV DATABASE_PATH=/app/data/vip.db

CMD ["node", "index.js"]
