FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN npx playwright install chromium

CMD ["node", "--env-file=.env", "dist/index.js"]
