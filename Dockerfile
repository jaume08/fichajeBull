FROM node:22-alpine
WORKDIR /app
ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY docs ./docs
ENV PORT=3000 DB_FILE=/app/data/fichaje.sqlite
VOLUME /app/data
EXPOSE 3000
# Carrega dades de demo només si la base de dades és buida, i arrenca el servidor
CMD ["sh", "-c", "node scripts/seed.js && node src/server.js"]
