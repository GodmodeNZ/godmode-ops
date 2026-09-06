# Purchasing currencies and NZD valuation

NZD is the accounting and inventory-cost base. Invoice and PO headers and lines retain their original currency and amounts. Rate direction is always **1 original currency = X NZD**; conversion multiplies, never divides.

## Reviewing an invoice

1. Verify the original currency, invoice date, quantities and prices against its attachment. Unidentified or mixed currency is `XXX` and cannot be approved until corrected. Existing NZD records retain rate 1; existing foreign records are marked for review with no assumed rate.
2. Look up the invoice-date rate or enter a manual rate with its effective date and source/reason. A successful lookup is saved **unconfirmed**. Review the direction and actual returned date and click **Confirm displayed rate**. Changing currency or invoice date invalidates confirmation and clears the old rate.
3. Enter freight, import charges and payment fees separately in the invoice currency. Recoverable tax stays outside stock cost. For each nonzero charge choose expense, allocation by goods value, allocation by quantity, or manual original-currency amounts per line. Manual allocations must add up to the charge. A payment fee already recorded here must not be entered again as another stock cost.
4. Review original and NZD totals and costs side by side. Unknown amounts stay blank, including reconstructed Amazon records with USD goods prices but only an NZD checkout total. An historical reference rate does not establish an original total, GST or a bank payment.
5. Confirm component matches and approve. Approval stores the rate, dates, source, original values, converted values and allocation snapshot. API rules and database triggers lock the conversion and line costs. Payments can be recorded later without changing it.

Create the receiving PO from the approved invoice. A pre-existing draft PO must be unlinked before invoice approval so the receiving PO has precisely the approved original lines and locked costs. Do not receive the earlier draft as well. Independent POs also support a currency, order/rate date, historical lookup, manual rate, charges and allocation; marking one ordered locks its costs. An already ordered legacy foreign PO may only have its rate reviewed when nothing has been received. Historical foreign receipts require a deliberate valuation correction; they are never silently revalued.

## Historical provider

Provider: [Frankfurter v1](https://frankfurter.dev/v1/), ECB daily reference rates. [NZD coverage](https://frankfurter.dev/currencies/nzd/).

Request: `GET https://api.frankfurter.dev/v1/YYYY-MM-DD?base=USD&symbols=NZD` (substitute the original currency).

No API key is needed. Only the currency pair and requested date leave the ERP. The returned base, positive NZD rate and effective date are validated. We persist the requested date, actual returned date and exact source URL. Weekends/holidays can return the preceding business day; dates after the invoice or more than seven days before it are rejected. Unsupported currencies, future dates, timeouts and failures leave manual entry available and never substitute rate 1. Source quotes are daily reference rates, not intraday or card-settlement rates. The provider remains an external availability dependency.

## Rounding and cost flow

- Rates: up to ten decimal places. NZD unit-cost evidence: eight decimal places. Money and ledger values: integer cents using decimal arithmetic and half-up rounding.
- Goods conversion and charge allocations use a deterministic largest-remainder allocation of cents. Each allocated line total is persisted.
- A partial receipt takes `round(line stock value * cumulative received / ordered) - round(line stock value * previously received / ordered)`. All splits therefore sum exactly to the locked full line value.
- Inventory receives **NZD values only**. It does not look up or reapply a rate. Original PO unit prices remain original currency. The ledger stores exact NZD movement value separately from the legacy unit-cost field; serialized costs reconcile to their receipt value.
- Weighted-average inventory, transfers, consumption, saved build-component values, BOM estimates and reports use these NZD costs. Component line totals are saved to avoid rounding differences when assembling several fractional-cost lines.
- Margin reports use completed build costs and NZD sales revenue less explicitly supplied sales tax. Missing tax/revenue, foreign sales revenue or incomplete costs are shown as needing review, not as fabricated margins. Component margins exclude labour and overhead.
- Actual NZD payments are separate dated, referenced records. They do not replace the approved conversion or alter stock costs. The payment list is not an assertion that an order was paid in full.

## Existing records and deployment

Migration `202609060001_multicurrency` is additive. It adds fields and a payment table; existing currency, original amounts, attachments and ledger rows are preserved. It assigns identity rates only to NZD. Existing foreign invoices/POs need rate review; ledger entries linked to unreviewed historical foreign POs are excluded from reliable valuation, with review indicators. No original ledger entry is rewritten.

Back up the database, `.env`, `.data/integration.key` and current source before deployment. Apply `prisma migrate deploy`, generate the Prisma client and build. Restart the API directly; do not reset/reseed or use a fresh-install launcher against an existing installation. Preserve Gmail/Shopify configuration and login data.

## Tests

`npm test` accepts only a disposable `godmode_fx_isolated_test_<timestamp>` or `godmode_ops_ci_test` database. It refuses the local `godmode_ops_test` ERP database despite its misleading name. CI uses its own Postgres service.

For local migration verification, supply a Postgres administrator connection in `FX_TEST_ADMIN_URL` and run `node scripts/fx-isolated-db.mjs`. This creates a separate database, applies the previous migrations, inserts clearly named legacy test fixtures, then applies the new migration. Its URL is stored under ignored `.data/fx-test-url`; provide that URL as `DATABASE_URL` to `npm test`. No existing database is reset. The test database is left available for inspection.

Coverage includes direction, identity rates, actual provider effective date, failed lookup, explicit confirmation, stale edits, manual override, allocation reconciliation, fractional-cent partial/serialized receipts, approval/database locking, separate payments, original PO amounts, stock/BOM/build/margin flow, legacy foreign review flags and the existing NZD/integration suite.
