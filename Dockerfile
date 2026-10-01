FROM node:22-alpine
RUN apk add --no-cache su-exec
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p /app/data \
  && chown -R node:node /app/data \
  && chmod +x ./docker-entrypoint.sh
ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/app/data/maison-sol.sqlite
EXPOSE 3000
# Start as root so the entrypoint can chown a Fly volume at /data, then drop to node.
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["npm", "start"]
