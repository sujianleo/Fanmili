ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && mkdir -p /app/models \
    && cp node_modules/@tesseract.js-data/chi_sim/4.0.0/chi_sim.traineddata.gz /app/models/ \
    && cp node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz /app/models/

FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3100 \
    OCR_MODEL_PATH=/app/models
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=dependencies --chown=node:node /app/models ./models
COPY --chown=node:node server.js ./server.js
USER node
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:3100/health"]
CMD ["node", "server.js"]
