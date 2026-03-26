FROM node:22-bookworm-slim

WORKDIR /app/offchain-backend

COPY offchain-backend/package.json offchain-backend/package-lock.json ./
RUN npm ci --omit=dev

COPY offchain-backend ./
COPY new-skills ../new-skills

ENV HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000

CMD ["./docker-entrypoint.sh"]
