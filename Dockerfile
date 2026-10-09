FROM node:22-alpine
WORKDIR /app
COPY package.json server.js index.html ./
COPY css ./css
COPY js ./js
ENV PORT=3000 DB_PATH=/data/ballpark.db
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
