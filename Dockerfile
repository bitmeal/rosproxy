FROM node:alpine

COPY . /app
WORKDIR /app

RUN npm ci

ENTRYPOINT ["node", "/app/rosproxy-cli.js"]