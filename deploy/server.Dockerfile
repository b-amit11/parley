FROM node:24-alpine
WORKDIR /app
# Install dependencies first, so source edits don't invalidate this layer.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/loadtest/package.json apps/loadtest/
RUN npm ci --omit=dev --ignore-scripts
COPY packages/shared packages/shared
COPY apps/server apps/server
ENV NODE_ENV=production
USER node
EXPOSE 3000
# Default SIGTERM handling closes sockets with 1001 so clients reconnect to another server.
CMD ["node", "--import", "tsx", "apps/server/src/main.ts"]
