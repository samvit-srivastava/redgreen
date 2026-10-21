# RedGreen worker + website. Includes Chromium for website mode.
FROM mcr.microsoft.com/playwright:v1.48.2-jammy
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY . .
# Reachable from outside: set REDGREEN_PASSWORD (e.g. in Render's dashboard). Without it, GitHub mode, the bot
# and the settings pages stay OFF, because anyone could otherwise make this server clone and run code.
ENV HOST=0.0.0.0 PORT=3000 REDGREEN_ALLOW_REPO_CODE=1 GEMMA_PROVIDER=gemini
EXPOSE 3000
CMD ["node", "server.js"]
