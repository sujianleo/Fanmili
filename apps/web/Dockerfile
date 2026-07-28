ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM ${NODE_IMAGE} AS builder
WORKDIR /app
ARG NEXT_PUBLIC_FAMILY_APP_LAN_ADDRESS=""
ARG NEXT_PUBLIC_FAMILY_APP_AUTH_REQUIRED="true"
ARG NEXT_PUBLIC_FAMILY_APP_AUTH_PROVIDER="local"
ARG NEXT_PUBLIC_FAMILY_APP_BACKEND="sqlite"
ARG NEXT_PUBLIC_APP_BASE_PATH=""
ARG NEXT_PUBLIC_VAPID_PUBLIC_KEY=""
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning
ENV NEXT_PUBLIC_FAMILY_APP_LAN_ADDRESS=$NEXT_PUBLIC_FAMILY_APP_LAN_ADDRESS
ENV NEXT_PUBLIC_FAMILY_APP_AUTH_REQUIRED=$NEXT_PUBLIC_FAMILY_APP_AUTH_REQUIRED
ENV NEXT_PUBLIC_FAMILY_APP_AUTH_PROVIDER=$NEXT_PUBLIC_FAMILY_APP_AUTH_PROVIDER
ENV NEXT_PUBLIC_FAMILY_APP_BACKEND=$NEXT_PUBLIC_FAMILY_APP_BACKEND
ENV NEXT_PUBLIC_APP_BASE_PATH=$NEXT_PUBLIC_APP_BASE_PATH
ENV NEXT_PUBLIC_VAPID_PUBLIC_KEY=$NEXT_PUBLIC_VAPID_PUBLIC_KEY
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    FAMILY_APP_BACKEND=sqlite \
    FAMILY_APP_SQLITE_PATH=/app/data/family.sqlite \
    FAMILY_APP_ALLOW_FILE_FALLBACK=true \
    FAMILY_APP_DEMO_DATA=false \
    FAMILY_APP_TRIAL_MODE=false \
    NEXT_PUBLIC_FAMILY_APP_AUTH_REQUIRED=true \
    NEXT_PUBLIC_FAMILY_APP_AUTH_PROVIDER=local \
    NEXT_PUBLIC_FAMILY_APP_BACKEND=sqlite

RUN apk add --no-cache su-exec \
    && addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs \
    && mkdir -p /app/data \
    && chown -R nextjs:nodejs /app/data

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --chown=nextjs:nodejs docker-entrypoint.sh /app/docker-entrypoint.sh
COPY --chown=nextjs:nodejs fnos-gateway-proxy.mjs /app/fnos-gateway-proxy.mjs

RUN chmod 755 /app/docker-entrypoint.sh

USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "(async()=>{for(const path of ['/app/fanmili/api/setup/status','/api/setup/status']){try{if((await fetch('http://127.0.0.1:3000'+path)).ok)process.exit(0)}catch{}}process.exit(1)})()"]
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]
