# Operations and integrations

## Architecture and transactional rules

The dashboard and API are served from the same origin. The API is under `/api`; `/health` checks database connectivity. PostgreSQL remains authoritative. The server creates the first administrator from `ADMIN_EMAIL` and `ADMIN_PASSWORD` only when there are no users.

Operational writes require an `Idempotency-Key` header of 8–128 characters. Reuse the key when retrying the same request. A key used with different data, route or actor is rejected. Browser actions supply keys automatically. Results and audit records commit with the domain transaction.

All operational transactions acquire one PostgreSQL transaction-level advisory lock. This serializes writes across server instances and prevents allocation/receiving races. This is deliberate for a small factory workload. Reads remain concurrent. A partial unique index additionally prevents multiple active reservations for one physical serial. The ledger rejects UPDATE and DELETE at database level.

## Fresh installation

Use a dedicated PostgreSQL database. Set `ERP_TEST_MODE=false` for actual operations and configure a strong initial administrator password. Set `WEB_ORIGIN` to the exact browser origin; it is checked on writes. Use `COOKIE_SECURE=true` for HTTPS. Do not publish a production installation on plain HTTP.

`docker compose up --build -d` starts PostgreSQL 17, runs migrations and serves the built dashboard. PostgreSQL is not published on a host port. The app listens on port 4000. The volume survives app updates and container restarts.

## Existing M1–M5 installation

1. Back up the existing database and verify that you can restore it to a separate database.
2. Install dependencies and generate the Prisma client.
3. Review that the existing schema corresponds to the previous M5 schema in this repository's history. Custom deployments must reconcile their differences first.
4. Run `npm run db:deploy -- --baseline-existing` against the existing database. This marks the baseline as already present and applies only the additive workflow migration.
5. If old data violates the new reservation or receipt constraints, the workflow migration rolls back. Repair the data through a documented, reviewed reconciliation, then retry the migration. Do not discard history to make constraints pass.

The launcher never resets a database. Existing ledger entries, products, BOMs, mappings and builds are preserved.

## Shopify

Configure `SHOPIFY_STORE_DOMAIN` as the exact `your-store.myshopify.com` domain. Supply either `SHOPIFY_ADMIN_ACCESS_TOKEN` or the already supported `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` credentials. Default API version is `2026-07`.

The order query requires order access, plus customer/product access for the selected fields. Use appropriate read scopes for the installation. Order access is subject to Shopify's historical window and protected customer-data permissions. The source query is in `apps/api/src/integrations.ts`.

Create mappings in Settings. Variant matches precede product matches; SKU mappings are the fallback. A configuration rule maps an exact order option name/value to a BOM role and SKU. Unknown values for configured options block resolution. Existing COLOSSUS and other mappings remain in the database.

Use Settings → Import open orders for a paginated import of open paid Shopify orders. The import is disabled in test mode. Repeat imports do not duplicate build snapshots. Orders over 100 line items fail explicitly instead of silently truncating. The older catalogue scanner remains available through `npm run shopify:sync` (dry run) and `npm run shopify:sync -- --write` (ERP catalogue import).

Create these Shopify webhook subscriptions pointing to your HTTPS installation:

| Shopify topic | ERP endpoint |
| --- | --- |
| orders/paid | `/api/integrations/shopify/webhooks/orders-paid` |
| orders/updated | `/api/integrations/shopify/webhooks/orders-updated` |
| orders/cancelled | `/api/integrations/shopify/webhooks/orders-cancelled` |

Set `SHOPIFY_WEBHOOK_SECRET` to the signing secret and `DEFAULT_INVENTORY_LOCATION_ID` to the location to reserve from. Without a default location, imports create builds for manual reservation. The receiver verifies the raw body signature, exact store domain and event ID. Failed events can be retried; a previously failed event is not treated as successfully processed. Settings shows status and failures. ERP_TEST_MODE disables live webhooks.

Order changes after production snapshots exist are held for review. Existing builds are preserved. To reconcile a changed unstarted order, cancel the old ERP work and create the replacement paid manual production order with a clear reference to the Shopify order; the underlying Shopify order remains the authority. Do not create replacement work for a unit already in production without reviewing it.

Shopify inventory, payments, refunds and fulfilment are not written by this application. Do not interpret ERP dispatch as a Shopify fulfilment notification.

Official references: [Order query](https://shopify.dev/docs/api/admin-graphql/2026-07/queries/order), [Order access](https://shopify.dev/docs/api/admin-graphql/latest/objects/Order), [Webhook topics](https://shopify.dev/docs/api/admin-graphql/latest/enums/WebhookSubscriptionTopic).

## Factory Controller

Set a strong `FACTORY_API_TOKEN` on the server. Configure the Controller with the server URL, a Bearer token and a unique Idempotency-Key for each report/event. Tokens are restricted to `/api/factory/` endpoints.

- `GET /api/factory/builds/ready`
- `GET /api/factory/builds/:buildNumber`
- `POST /api/factory/builds/:buildNumber/hardware-report` — `{ "station": "bench-1", "agentId": "pc-agent", "hardware": { ... }, "passed": true }`
- `POST /api/factory/builds/:buildNumber/events` — `{ "type": "DEPLOYMENT_COMPLETED", "metadata": { ... } }`

Event types: DEPLOYMENT_STARTED, DEPLOYMENT_COMPLETED, DEPLOYMENT_FAILED, TEST_RESULT. Hardware reports remain evidence; they do not automatically pass manual QA or consume stock. Updating the separately running Controller software is a separate integration deployment.

## Backup and restore

For Docker, take a binary backup using the Node helper (works on Windows without shell redirection corrupting binary output):

```sh
node scripts/backup.mjs
```

This writes an ignored `.data/backups/godmode-ops-TIMESTAMP.dump` using `pg_dump --format=custom` inside the database container. Copy backups to separate, access-controlled storage. Test restore to a separate empty database before relying on the process. Never test a restore over the live database.

Restore a downloaded custom-format dump using PostgreSQL's `pg_restore` into a separately created empty database. Set the application DATABASE_URL to that restored test database and verify quantities, serial history, builds and logins before any cutover.

For the Windows embedded test server, close the launcher and copy `.data/postgres` plus `.env` to a secure location. An active database directory must not be copied as a substitute for a consistent database backup.

## Limits

Interactive tables currently load up to 2,000 builds/orders/POs and show 30 rows per page; history loads the latest 1,000 movements/actions. Those limits do not delete records. For higher volume, introduce server-side pagination and targeted dashboard queries. Operational writes are serialized; reassess lock scope only with concurrency tests in place.
