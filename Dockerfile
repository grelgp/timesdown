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
CMD ["node", "server.js"]
