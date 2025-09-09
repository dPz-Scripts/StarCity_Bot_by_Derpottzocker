# ---- Build cache buster (jede Änderung -> Full Rebuild) ----
ARG APP_REV=v4-01
ENV APP_REV=${APP_REV}

# ---- Basis ----
FROM node:22-alpine

WORKDIR /app

# Nur package-Dateien zuerst (Cache effizient)
COPY package*.json ./

# Prod-Dependencies
RUN npm ci --omit=dev

# Rest der App
COPY . .

# Port
ENV PORT=3000

# Start
CMD ["node", "src/index.js"]
