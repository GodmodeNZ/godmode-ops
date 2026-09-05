# Godmode Ops

Godmode NZ's operations ERP: component inventory, purchasing, versioned BOMs, Shopify production intake, serialized builds, QA, dispatch and service history.

React/TypeScript dashboard + Fastify/TypeScript API + PostgreSQL. Shopify remains the sales authority. The factory Controller communicates through the API. All persistent operational data lives in PostgreSQL.

## Test on Windows

1. Install Node.js 22 LTS or newer if it is not already installed.
2. Download or clone this repository, then double-click **Start-Godmode-Ops.cmd**.
3. Open **http://localhost:4000**. Sign-in details appear in the command window and in `.data/test-login.txt`.

The launcher installs dependencies, starts a local PostgreSQL server, applies migrations, creates sample stock and builds, and starts the application. Keep the window open. Data persists across restarts in `.data/postgres`. No Docker or separate database installation is needed for this test route. Do not delete `.data` or `.env` when updating.

The test environment is clearly labelled. Its stock, costs, supplier and PCs are examples. Live Shopify imports and webhooks are disabled in test mode. No orders are submitted to suppliers and no messages are sent to customers.

See [the test walkthrough](docs/TESTING.md).

Invoice import, supplier aliases and visible Shopify SKU matching are now available. See [invoice setup and matching](docs/INVOICES.md). To connect Shopify on Windows, run **Connect-Shopify.cmd**, sign in, then open **SKU Matching → Sync catalogue**. Keep `.env` and `.data` when copying updates.

## Included workflows

- Component families, SKUs, product barcodes, serial-number stock, locations, safety stock and stock search.
- Receiving, partial purchase-order receipts, transfers and reasoned stock adjustments.
- Append-only stock ledger, active reservations and weighted-average component costing.
- Products and permanent BOM versions with approved substitute components.
- Manual paid orders and Shopify paid-order imports, mappings and configurable upgrades.
- Retry-safe order resolution and signed Shopify webhooks, with failed-event retry.
- Production queue, component reservations, substitutions, assembly, six QA checks and completion.
- Permanent Godmode Unit IDs, as-built serial genealogy, component costs and dispatch records.
- Service tickets linked to the manufactured unit and original build history.
- Supplier quotes, PO drafts, shortages and replenishment grouped by supplier.
- Invoice inbox with preserved source files, conservative PDF/CSV/email extraction, per-line SKU review and duplicate protection.
- Explicit Shopify variant links, supplier aliases and frozen invoice match history.
- Gmail/Microsoft 365 read-only mailbox connection and manual invoice pulls.
- Stock valuation, finished-PC component costs, CSV exports and activity history.
- Administrator, operator and viewer accounts with revocable sign-in sessions.
- Controller endpoints for build allocations, detected hardware and deployment events.

## Server deployment

Copy `.env.example` to `.env` and set unique database and administrator passwords. For an isolated test server keep `ERP_TEST_MODE=true`; for actual operations use a new production database and `ERP_TEST_MODE=false`.

```sh
docker compose up --build -d
```

Open `http://localhost:4000`. Compose persists PostgreSQL in the `postgres_data` volume. It binds the app to the local machine by default. For access from the office network, set `BIND_ADDRESS` and `WEB_ORIGIN` to the intended address. For an internet-facing installation use an HTTPS reverse proxy, set `WEB_ORIGIN` to that exact HTTPS origin and `COOKIE_SECURE=true`.

See [deployment, backups and integration setup](docs/OPERATIONS.md). Existing M1–M5 databases require the documented one-time baseline; the migration runner detects them and stops before making changes unless explicitly baselined.

## Development and verification

```sh
npm ci
npm run prisma:generate
npm run db:deploy
npm run build
npm start
```

For live frontend development, set `WEB_ORIGIN=http://localhost:5173`, run `npm run dev:api`, then `npm run dev:web`. Vite proxies `/api` to the backend. For the built app use `WEB_ORIGIN=http://localhost:4000`.

Run database integration tests against a dedicated database whose URL contains `_test`, or a dedicated `schema=erp_test`:

```sh
DATABASE_URL=postgresql://postgres:password@localhost:5432/godmode_ops_test npm run db:deploy
DATABASE_URL=postgresql://postgres:password@localhost:5432/godmode_ops_test npm test
```

GitHub Actions runs compilation and the integration suite with PostgreSQL 17, including concurrent reservation tests. The suite creates uniquely named fixtures; it never clears an existing database.

## Operational boundaries

This implements the agreed stock, purchasing and PC production scope. It is not a general ledger, payroll, tax-filing or supplier-payment system. Component costs exclude labour, freight and overhead. Missing historical costs appear as zero and should be reconciled before relying on valuation reports.

Dispatch is recorded inside Godmode Ops; Shopify fulfilment and refunds stay in Shopify. Courier label buying and automatic supplier ordering are not enabled. The Controller API is implemented; the running Controller must be configured to send to this server. Shopify credentials and webhook subscriptions belong to the installation and are never included in source.

Order edits after builds exist are explicitly blocked for review rather than silently changing the original build. Refunds/cancellations release unstarted production and flag work already in progress. Financial refunds remain in Shopify.
