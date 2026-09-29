FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p /app/data && chown -R node:node /app/data
ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/app/data/maison-sol.sqlite
EXPOSE 3000
USER node
CMD ["npm", "start"]
