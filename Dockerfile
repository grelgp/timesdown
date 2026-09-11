# No dependencies and no build step — the whole app is server.js + public/ —
# so unlike webwolf and aerogreg there is no builder stage to copy out of.
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json server.js ./
COPY public ./public

# Rooms live in memory and nothing is ever written to disk, so the app has no
# reason to be root.
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1 || exit 1
CMD ["node", "server.js"]
