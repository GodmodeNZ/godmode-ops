FROM node:22-bookworm-slim AS app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY prisma ./prisma
RUN npm ci
COPY . .
RUN npm run prisma:generate && npm run build
ENV NODE_ENV=production API_PORT=4000
USER node
EXPOSE 4000
CMD ["sh", "-c", "npm run db:deploy && if [ \"$ERP_TEST_MODE\" = \"true\" ]; then npm run seed; fi && npm start"]
