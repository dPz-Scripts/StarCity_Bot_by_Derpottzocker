# ---- Force full rebuild when this changes ----
ARG APP_REV=v4-04

# ---- Base image ----
FROM node:22-alpine

# cache-buster var (must be AFTER FROM)
ENV APP_REV=${APP_REV}

WORKDIR /app

# Copy only package files first (better cache)
COPY package*.json ./

# Install prod deps (robust: npm install statt npm ci)
RUN npm install --omit=dev --no-audit --no-fund

# Copy the rest of the app
COPY . .

# Runtime env
ENV NODE_ENV=production
ENV PORT=3000

# Start
CMD ["node", "src/index.js"]
