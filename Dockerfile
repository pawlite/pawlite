FROM node:22-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
ENV DATA_DIR=/data
VOLUME /data
# Run as a non-root user; the shell tool (if enabled) runs as this user, inside the container only.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
CMD ["npx", "tsx", "src/index.ts"]
