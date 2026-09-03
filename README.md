# Godmode Ops

Purpose-built operations platform for Godmode NZ. The current M2 foundation covers inventory, BOMs, serialized component allocation, production builds and manufactured-PC genealogy.

## Architecture

- `apps/api` — Fastify + TypeScript business API
- `apps/web` — React + Vite operations dashboard
- `prisma` — PostgreSQL domain schema
- PostgreSQL is authoritative for inventory, BOMs, reservations, builds and manufactured units

## Domain rules

1. Inventory changes only through immutable ledger entries.
2. Reservations commit stock without changing on-hand quantity.
3. Serialized SKUs create one `InventoryUnit` per physical serial number.
4. Serialized reservations bind a specific physical unit to a specific build/BOM line.
5. BOMs are versioned; builds snapshot a BOM at creation.
6. Build completion consumes reservations transactionally and transfers serial genealogy into the manufactured PC.
7. Completed PCs receive a unique Godmode Unit ID and permanent as-built component record.

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

## M2 dashboard

The dashboard now includes:

- stock position with on-hand / reserved / available quantities
- searchable inventory
- barcode-assisted receiving
- serialized receiving with one serial number per physical unit
- product and versioned BOM management
- build queue and reservation visibility
- manufactured unit list

## Factory / Controller API

- `GET /factory/builds/ready` — builds ready for Controller/deployment work
- `GET /factory/builds/:buildNumber` — expected build and allocated component detail
- `POST /factory/builds/:buildNumber/hardware-report` — Controller/Agent detected-hardware report
- `POST /factory/builds/:buildNumber/events` — deployment, test and QA events

Core endpoints also include catalog, barcode lookup, inventory units/movements, receiving, products/BOMs, build reservation/start/completion and unit genealogy.

## Next milestone

M3 should connect Shopify orders/configurations to Godmode products and build BOM snapshots, then add purchasing/supplier records and reorder planning.
