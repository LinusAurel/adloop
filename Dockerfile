FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm build
ENV NODE_ENV=production
EXPOSE 10000
CMD ["./node_modules/.bin/next", "start"]
