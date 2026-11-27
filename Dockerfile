# 智慧校园平台（演示）镜像
FROM node:24-slim

WORKDIR /app

# 依赖层单独缓存
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server.js ./
COPY public ./public

# 数据目录（挂卷持久化）
RUN mkdir -p /data && chown -R node:node /data /app
ENV PORT=8099 \
    DATA_DIR=/data \
    NODE_ENV=production \
    SHOW_DEV_CODE=1
VOLUME ["/data"]
EXPOSE 8099

USER node
CMD ["node", "server.js"]
