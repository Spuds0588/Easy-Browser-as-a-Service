# Easy Browser-as-a-Service
#
# The Puppeteer base image already ships Chromium and the shared libraries it
# needs, so we only add our stateless Node server on top.
#
# PINNED, not :latest — the bundled Chromium must stay in lockstep with the
# `puppeteer` version in package-lock.json (both 23.11.1). Bump them together.
FROM ghcr.io/puppeteer/puppeteer:23.11.1

ENV NODE_ENV=production \
    PORT=8080 \
    PUPPETEER_SKIP_DOWNLOAD=true

USER root
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --chown=pptruser:pptruser server ./server
COPY --chown=pptruser:pptruser public ./public

USER pptruser

EXPOSE 8080

# Healthcheck hits the stateless /healthz probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
