FROM node:slim
# node:slim (based on debian) seems to support use of hosts mdns resolver
# FROM node:alpine

COPY package*.json /app/

WORKDIR /app
RUN npm ci

COPY . /app

ENTRYPOINT ["node", "/app/rosproxy-cli.js"]