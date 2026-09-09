FROM node:24-bookworm

WORKDIR /app

COPY package.json ./

RUN apt-get update \
    && apt-get install --yes --no-install-recommends sudo \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --omit=dev \
    && npm install --global agent-browser \
    && agent-browser install --with-deps \
    && npm cache clean --force

COPY server.js model-builder.js ./

ENV NODE_ENV=production
ENV PORT=3000
ENV FILES_DIR=/files

EXPOSE 3000

CMD ["node", "server.js"]
