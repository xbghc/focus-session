FROM node:22-bookworm-slim AS build
WORKDIR /build/server
# The shared protocol lives outside server/; NodeNext also needs the root ESM package boundary.
COPY package.json /build/package.json
COPY server/package.json server/package-lock.json ./
RUN npm ci --ignore-scripts
COPY server/tsconfig.json ./
COPY server/src ./src
COPY src/sync/protocol.ts /build/src/sync/protocol.ts
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/data
WORKDIR /app
COPY --from=build /build/server/package.json ./package.json
COPY --from=build /build/server/node_modules ./node_modules
COPY --from=build /build/server/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/src/main.js"]
