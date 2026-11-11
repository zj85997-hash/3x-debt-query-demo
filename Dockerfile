FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY db.mjs server.mjs candidate-pair.mjs ./
COPY public ./public
COPY fixtures/notice-candidates.json ./fixtures/notice-candidates.json
COPY docs/data/synthetic-bulk.json ./docs/data/synthetic-bulk.json
COPY scripts/seed.mjs ./scripts/seed.mjs
USER node
ENV HOST=0.0.0.0 PORT=8931
EXPOSE 8931
CMD ["node","server.mjs"]
