FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/loadtest/package.json apps/loadtest/
RUN npm ci --ignore-scripts
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build -w @parley/web

FROM nginx:1.27-alpine
COPY deploy/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
