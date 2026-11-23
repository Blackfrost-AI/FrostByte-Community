# Docker Official Image, multi-platform index for Node 22.23.2 on Bookworm.
# Refresh this reviewed digest deliberately; never resolve a floating image at setup time.
FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS dependencies
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY build/ipfs-runtime.json ./build/ipfs-runtime.json
COPY scripts/build-ipfs-runtime.js ./scripts/build-ipfs-runtime.js
RUN npm ci --omit=dev --ignore-scripts && npm rebuild node-datachannel utp-native bufferutil utf-8-validate

RUN node scripts/build-ipfs-runtime.js

FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/build/ipfs-runtime ./build/ipfs-runtime
COPY package.json ./
COPY LICENSE THIRD_PARTY_NOTICES.md LICENSES.third-party.txt ./
COPY src/main ./src/main
COPY src/shared ./src/shared
COPY src/agent ./src/agent
ENV FROSTBYTE_AGENT_HOME=/state FROSTBYTE_DOWNLOAD_DIR=/downloads
CMD ["node", "src/agent/server.js"]
