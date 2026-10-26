# One container for hosted demos (Render, Fly.io, Railway): the Node server serves the built web
# app and the API under /api, so no nginx is needed. The cluster setup in docker-compose.yml is
# still the way to run several servers behind a load balancer.
FROM node:24-alpine AS web
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/loadtest/package.json apps/loadtest/
RUN npm ci --ignore-scripts
COPY packages/shared packages/shared
COPY apps/web apps/web
# Shows the seeded demo login on the sign-in screen; must match DEMO_PASSWORD in the seed.
ARG VITE_DEMO_LOGIN=alice:parley-demo
ENV VITE_DEMO_LOGIN=$VITE_DEMO_LOGIN
RUN npm run build -w @parley/web

FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/loadtest/package.json apps/loadtest/
RUN npm ci --omit=dev --ignore-scripts
COPY packages/shared packages/shared
COPY apps/server apps/server
COPY --from=web /app/apps/web/dist /app/public
COPY deploy/start-single.sh /app/start.sh
ENV NODE_ENV=production STATIC_DIR=/app/public PORT=3000
USER node
EXPOSE 3000
CMD ["sh", "/app/start.sh"]
