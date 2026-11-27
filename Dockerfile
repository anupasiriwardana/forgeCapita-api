# Multi-stage image for the ForgeCapita API.
#   docker build --target dev ...   local development (tsx watch; used by docker-compose)
#   docker build ...                production runtime (default, last stage)
# A separate Secret Shopper worker entrypoint (API-90) is deferred until API-54 exists.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM deps AS dev
COPY . .
EXPOSE 3001
CMD ["npm", "run", "dev"]

FROM deps AS build
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Read at runtime relative to the working directory; root-owned and read-only for the node user.
COPY migrations ./migrations
COPY legal ./legal
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD wget -q -O /dev/null http://127.0.0.1:3001/health || exit 1
CMD ["node", "dist/index.js"]