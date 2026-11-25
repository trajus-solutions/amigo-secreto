FROM node:24-alpine
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
ENV PORT=3000 HOST=0.0.0.0 TRUST_PROXY=1 DATA_DIR=/data NODE_ENV=production
VOLUME /data
USER node
EXPOSE 3000
CMD ["node", "server.js"]
