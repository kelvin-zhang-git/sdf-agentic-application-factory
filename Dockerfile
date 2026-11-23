# 与 node:22-alpine 相同。vm-9 访问 Docker Hub 不稳定，改从 DaoCloud 拉取。
FROM docker.m.daocloud.io/library/node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps --registry=https://registry.npmmirror.com
COPY . .
RUN npm run build

FROM docker.m.daocloud.io/library/node:22-alpine
# 基础镜像已经有 uid/gid 1000 的 node 用户，直接用它跑服务。
WORKDIR /app
# 当前构建产物在 dist/，服务端依赖仍从 node_modules 加载。
COPY --from=build /src/dist ./dist
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/package.json ./package.json
COPY --from=build /src/package-lock.json ./package-lock.json
COPY --from=build /src/drizzle/migrations ./drizzle/migrations
COPY deploy/vm9/node-server.mjs ./node-server.mjs
COPY deploy/vm9/apply-migrations.mjs ./apply-migrations.mjs
COPY deploy/vm9/app-entrypoint.sh /entrypoint.sh
RUN sed -i 's/\r$//' /entrypoint.sh node-server.mjs apply-migrations.mjs && chmod 755 /entrypoint.sh \
  && npm prune --omit=dev --legacy-peer-deps
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]
