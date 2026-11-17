FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY tsconfig.json ./
COPY src ./src
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && npm ci --no-audit --no-fund \
 && apt-get purge -y --auto-remove python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
ENV DATA_DIR=/data
VOLUME /data
# Run as a non-root user; the shell tool (if enabled) runs as this user, inside the container only.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
CMD ["npx", "tsx", "src/index.ts"]
