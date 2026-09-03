# Godmode Ops

Purpose-built operations platform for Godmode NZ. M1 focuses on inventory, BOMs, build reservations, consumption, and as-built PC genealogy.

## Architecture

- `apps/api` — Fastify + TypeScript business API
- `apps/web` — React + Vite dashboard
- `prisma` — PostgreSQL schema
- PostgreSQL is the source of truth for inventory, BOMs, builds, and manufactured units

## M1 domain rules

1. Inventory changes only through immutable ledger entries.
2. Reservations do not change on-hand stock.
3. BOMs are versioned; builds snapshot a BOM at creation.
4. Build completion consumes reserved inventory in a database transaction.
5. Completed PCs get a Godmode Unit ID and immutable as-built component records.

## Local setup

```bash
cp .env.example .env
docker compose up -d
npm install
npm run prisma:generate
npm run prisma:migrate
npm run dev:api
npm run dev:web
```

API: `http://localhost:4000`
Dashboard: `http://localhost:5173`

## Initial API surface

- `GET /health`
- `POST /component-families`
- `POST /skus`
- `POST /locations`
- `POST /inventory/receipts`
- `GET /inventory`
- `POST /products`
- `POST /products/:productId/bom-versions`
- `POST /builds`
- `POST /builds/:buildId/reserve`
- `POST /builds/:buildId/complete`
- `GET /builds`
- `GET /units/:unitNumber`

## Next milestone

M2: barcode receiving, serialized component allocation, richer Inventory/BOM screens, and controller-facing factory API.
