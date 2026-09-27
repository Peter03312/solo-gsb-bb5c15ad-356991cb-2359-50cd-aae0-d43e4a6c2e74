FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# 依赖安装纳入镜像构建，启动即就绪
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY src ./src
COPY public ./public

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
