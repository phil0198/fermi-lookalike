FROM node:22-alpine
WORKDIR /app
COPY package.json server.js store.js index.html ./
COPY css ./css
COPY js ./js
# The server starts as root only to take ownership of the mounted /data volume,
# then switches to RUN_AS before opening the database.
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/ballpark.db RUN_AS=node
RUN mkdir -p /data && chown node:node /data
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
