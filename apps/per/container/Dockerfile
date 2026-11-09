# The PER service container (apps/per). Node 22, production dependencies from the lockfile, TypeScript run by tsx.
FROM node:22.18.0-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
CMD ["node", "--import", "tsx", "src/index.ts"]
