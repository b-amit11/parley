FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/loadtest/package.json apps/loadtest/
RUN npm ci --omit=dev --ignore-scripts
COPY packages/shared packages/shared
COPY apps/web/src apps/web/src
COPY apps/loadtest apps/loadtest
ENTRYPOINT ["node", "--import", "tsx", "apps/loadtest/src/main.ts", "--url", "http://nginx", "--db", "postgres://parley:parley@postgres:5432/parley"]
