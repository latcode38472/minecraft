# The multiplayer server. The game client is a static site and is NOT in here —
# it deploys separately (see .github/workflows/deploy.yml).
#
# There is no build step: Node runs the TypeScript directly via its native type
# stripping, which is why the server's source can be copied in as-is.

FROM node:22-alpine

WORKDIR /app

# Install only runtime dependencies, and only re-run this layer when the
# lockfile actually changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# The server imports the shared simulation and protocol out of src/, so both
# directories are needed — but nothing from the browser client's UI.
COPY server ./server
COPY src ./src

# Hosts (Render, Fly, Railway, …) inject PORT; 8787 is the local default.
ENV NODE_ENV=production
EXPOSE 8787

# Bind all interfaces so the platform's router can reach the process.
ENV HOST=0.0.0.0

CMD ["node", "server/index.ts"]
