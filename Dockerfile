FROM node:24-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY shared ./shared
ENV NODE_ENV=production
EXPOSE 8787
CMD ["node", "server/index.js"]
