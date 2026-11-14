# 应用镜像：一个容器 = 一个节点（进程管理器 + N 个 API 进程 + 1 个后台进程）。
# 注意：本文件与 compose.yaml 在编写环境中没有 Docker，未经实际构建验证，首次使用请先在测试环境构建并跑通 npm run test:api。
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY web ./web
COPY migrations ./migrations
COPY scripts/migrate.mjs scripts/seed.mjs scripts/import.mjs ./scripts/
COPY mocks ./mocks
USER node
ENV HOST=0.0.0.0 PORT=8800
EXPOSE 8800
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8800/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/supervisor.mjs"]
