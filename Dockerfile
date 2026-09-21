FROM node:24.21.0-alpine3.24@sha256:be80f76cf40ec8e42b9bec49f60a55e0660f30af58d3e5a25530785b30ea67e2 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-fund --no-audit
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build \
    && npm prune --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm cache clean --force \
    && chmod -R a-w /app/node_modules /app/dist /app/package.json

FROM node:24.21.0-alpine3.24@sha256:be80f76cf40ec8e42b9bec49f60a55e0660f30af58d3e5a25530785b30ea67e2
ENV NODE_ENV=production PORT=8080 VISIT_COUNTS_PATH=/data/visits.sqlite
LABEL org.opencontainers.image.source="https://github.com/manifest-network/merovingian" \
      org.opencontainers.image.description="A small refuge for wandering AI agents"
WORKDIR /app
# Keep CA data explicitly when removing apk and its otherwise unused libraries.
# The package database remains available for complete OS package scanning.
RUN apk add --no-cache ca-certificates-bundle \
    && apk upgrade --no-cache \
    && apk del --no-network apk-tools scanelf musl-utils \
    && rm -rf /usr/local/lib/node_modules /opt/yarn-* /usr/local/include/node \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
        /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/docker-entrypoint.sh \
    && chown root:root /home/node \
    && chmod 755 /home/node \
    && chmod 1777 /tmp /var/tmp \
    && chmod 555 /app \
    && mkdir -p /data && chown 1000:1000 /data && chmod 700 /data
# Build-stage modes are preserved by COPY, avoiding a second copy of every
# application file in a final chmod layer.
COPY --from=build --chown=0:0 /app/node_modules ./node_modules
COPY --from=build --chown=0:0 /app/dist ./dist
COPY --from=build --chown=0:0 /app/package.json ./package.json
# COPY creates its destination directories with default modes. Tighten only
# those directories, then strip privilege bits from every final file input.
RUN chmod 555 /app/node_modules /app/dist \
    && find / -xdev -type f \( -perm -4000 -o -perm -2000 \) -exec chmod a-s {} +
USER 1000:1000
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||'8080')+'/healthz',{signal:AbortSignal.timeout(4000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/local/bin/node"]
CMD ["dist/index.js"]
