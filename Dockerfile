FROM node:20-alpine

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY index.js ./

RUN mkdir -p /app/data && chmod 777 /app/data

ENV NODE_ENV=production
ENV DATABASE_PATH=/app/data/vip.db

CMD ["node", "index.js"]
