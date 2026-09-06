# Akahu bank feeds and supplier reconciliation

## Current installation and callback

The existing local ERP is `http://localhost:4000`. Its exact development callback is:

`http://localhost:4000/api/banking/callback`

Register this URI with Akahu for development **if Akahu approves a localhost callback for the issued full app**. The callback is computed from `WEB_ORIGIN` by default and displayed under **Banking**. `AKAHU_REDIRECT_URI` can override it, but its path must remain `/api/banking/callback`, without a query or fragment. It must exactly match the app's registered redirect URI.

Production banking requires an HTTPS `WEB_ORIGIN`, an HTTPS registered callback on the ERP deployment, secure cookies (`COOKIE_SECURE` must not be `false`), and `AKAHU_COMMERCIAL_APPROVED=true`. Do not enable that flag until Akahu has approved commercial production use. The current localhost HTTP installation is not an accredited production banking deployment. Changing these deployment settings must preserve existing Gmail redirect registration, Shopify configuration and existing login/session data; register and test the integration callbacks for the chosen HTTPS origin before switching it.

## Credentials and onboarding

1. Request a **full app for enduring account/transaction information** from Akahu, initially with sandbox access. Discuss the BNZ business accounts and bank login types you need, history coverage (at least six months if required), refresh frequency and commercial pricing. Personal apps are not a substitute for production business reconciliation.
2. Obtain the full-app **App ID Token**, **App Secret**, and approved redirect registration. Configure only `ACCOUNTS` and `TRANSACTIONS` read permissions with enduring consent. No identity or payment-initiation permissions are needed. The authorization request sends the explicit scope string `ENDURING_CONSENT ACCOUNTS TRANSACTIONS`; it does not request every permission on the app.
3. Use an isolated database for sandbox testing. Open **Banking → Full-app connection settings**, choose Sandbox, enter the app credentials and the UTC history start date, and save. Secrets are submitted once and encrypted on the server using the existing AES-256-GCM integration key. They are not returned by the status API. The OAuth authorization URL necessarily contains the public App ID Token, but never the App Secret or user access token.
4. Choose **Connect full app**, complete Akahu's consent screen, and return to the callback. The server exchanges the short-lived authorization code, validates granted scopes, and stores the resulting token encrypted. It uses durable, expiring, single-use state tied to an administrator and an HttpOnly browser cookie. Changes to settings invalidate older state. Callback URLs and authorization query strings are excluded from application request logs.
5. Choose **Load connected accounts**, then select eligible ACTIVE BNZ accounts with transaction access and a known currency. Other institutions cannot be selected. Inactive or unavailable accounts show a reconnect action. A migrated account whose predecessor already has imported history is held for manual migration review, preventing overlapping account histories from being counted twice.
6. Fetch cached transactions and review a synthetic/test reconciliation before enabling periodic cached imports. No invoice or SKU is approved by banking; no stock is received.
7. For commercial access, complete Akahu's contractual, due-diligence, privacy and application-review process yourself. Ongoing account-information access is currently Tier 2 and requires full app review. Supply the review deployment, access instructions, clear Akahu branding/information, data-retention policy and appropriate authentication/security controls. Akahu decides acceptance and issues production access; this code does not accept terms or claim accreditation.

**Remaining external prerequisites:** issued full-app credentials, Akahu sandbox/BNZ account eligibility, confirmed callback registration, production commercial approval/accreditation, and an approved HTTPS deployment. No personal-app-token input or token-based shortcut exists in the live ERP. Local mocked tests need none of these credentials.

Official sources checked 7 September 2026: [OAuth](https://developers.akahu.nz/docs/authorizing-with-oauth2), [authorization requests](https://developers.akahu.nz/me/docs/authorisation-request-anatomy), [scopes](https://developers.akahu.nz/docs/scopes), [accreditation](https://developers.akahu.nz/docs/app-accreditation).

## Imports, refreshes and recovery

- **Fetch cached transactions / resume** reads Akahu's current cached data. It does not initiate a bank refresh. Optional 15-minute automatic imports use this same cached read path and require the ERP server to remain running.
- Each import freezes account IDs and its UTC start/end window, persists each page with its next cursor in the same database transaction, and uses a durable expiring lease. After interruption, the worker resumes the saved page. Repeated posted IDs update the same record rather than creating new payments. HTTP 429 backoff is persisted; a 401 removes the invalid token and requests reauthorization without signing the user out of the ERP.
- Re-reading the selected history also detects modified/deleted posted records. Deletion is applied only after the account's full scan succeeds. Missing records are retained as `REMOVED` for audit; allocations on removed/changed records require review and reversal. Reconciliation is blocked during an unfinished scan and until a new complete scan succeeds after cancellation. A stable provider ID is not a guarantee that an underlying bank entry can never change.
- Pending entries have no stable provider ID. Each completed account scan replaces its pending preview. Pending entries are never allocatable or included in reconciled payment totals. When an entry posts, only its posted ID becomes eligible; a pending amount cannot be counted again as an invoice payment.
- **Request bank refresh** is separate and explicit. It groups selected accounts by bank authorization, respects a server cooldown of at least 15 minutes (configurable upward using `AKAHU_REFRESH_REST_MINUTES`), skips recently refreshed accounts and honors provider rate limits. Akahu may defer refreshes and may refresh other accounts sharing a login. A successful request is not a promise of fresh bank data. Inspect account freshness timestamps after loading accounts or beginning another cached import.

Sources: [transaction synchronization, pagination and pending data](https://developers.akahu.nz/docs/accessing-transactional-data), [data refreshes](https://developers.akahu.nz/docs/data-refreshes), [individual refresh behavior](https://developers.akahu.nz/reference/post_refresh-id), [account model](https://developers.akahu.nz/docs/the-account-model).

## Confirming and reversing matches

Open a posted debit's **Review / reconcile** action. Suggestions show invoice-number, supplier-name, original currency, amount and date evidence. Similar candidates are labelled ambiguous. Suggestions never create payments. You can choose another invoice, split a debit across invoices, or allocate only part of a debit.

For each allocation explicitly enter original invoice principal, actual NZD principal and any fee included in **that specific bank debit**. An independently charged fee is reconciled from its own debit with zero original/NZD principal and a positive fee. Do not include a fee twice. The original amount cannot exceed the remaining invoice total, and combined principal plus fees cannot exceed the bank debit. Database locks, idempotency keys, revision checks and a database constraint protect against duplicate/concurrent allocation.

Only posted outgoing **NZD** bank transactions create actual NZD invoice payments. Non-NZD bank accounts can be imported and viewed, but their debit is not silently treated as an NZD settlement. Unknown invoice totals/currencies need correction before allocation. Existing unlinked manual payments require review; an administrator can reverse a duplicate manual payment with a reason before adding its bank reconciliation. Reversal must reflect a real correction, not hide a valid payment.

The invoice retains its original currency/amounts and approved exchange rate. An allocation stores original principal, actual NZD principal, fee, approved-rate basis and exchange difference separately. A positive difference means more NZD principal was paid than the approved conversion. If the foreign invoice has no approved rate, the difference remains unknown; approve the invoice independently and, when appropriate, reverse/reconfirm the payment allocation to establish its approved-rate basis. No reconciliation action updates historical stock values, purchase-order costs, BOM/build costs or invoice approval status.

Payment dates are the Pacific/Auckland calendar date of the bank timestamp; the original timestamp remains on the imported transaction. Confirmations save their evidence and actor. **Reverse allocation** records actor, time and reason, reverses its linked payment, and frees the allocated bank/invoice amount. Original allocation rows cannot be edited or deleted. Changed or removed reconciled bank entries must be reviewed before making replacement allocations.

## Disconnect, security and retention

**Disconnect and revoke** calls Akahu's `DELETE /token`, stops imports, clears OAuth state and removes the stored user token after confirmed revocation (or a 401 confirming it is already invalid). If revocation fails, importing stops and the encrypted token is retained for a retry. Users can also revoke through [my.akahu.nz](https://my.akahu.nz/); the ERP handles subsequent 401 responses. Optional disconnect cleanup deletes never-allocated transactions and all pending previews while retaining reconciliation/reversal evidence. Review retention obligations with Akahu during onboarding. Account metadata and historical accounting evidence remain available to administrators.

Banking is administrator-only. Request handlers use a fixed Akahu API host and an explicit allowlist of reads, token exchange/revocation and refresh requests. There is no payment-initiation endpoint. Credentials use the existing `INTEGRATION_ENCRYPTION_KEY` or `.data/integration.key`; back up that key securely with the database. API responses, idempotency records and logs never include bank secrets or access tokens. Do not commit `.env`, `.data`, exported transactions, invoices, backups or bank credentials. The public repository contains only application code, migration structure and clearly synthetic test records.

Sources: [revoking tokens](https://developers.akahu.nz/reference/delete_token), [revocation and consumer controls](https://developers.akahu.nz/docs/best-practices).

## Migration and validation

Migration `202609070001_banking` adds bank connection state, accounts, sync progress, transactions and audited allocations, plus optional banking/reversal fields on existing invoice payments. It does not rewrite existing invoice values, exchange rates, ledger movements or integration settings. Back up the live database and configuration before applying `prisma migrate deploy`; generate the Prisma client and build. Restart the server directly without using a fresh-install/reseed launcher.

`scripts/fx-isolated-db.mjs` creates a new disposable database, applies old migrations, inserts synthetic legacy currency fixtures, then applies both additive feature migrations. Supply `FX_TEST_ADMIN_URL` securely. Its connection URL is stored under ignored `.data/fx-test-url`; pass that value as `DATABASE_URL` to `npm test`. The test runner rejects the actual local ERP database even though its name ends with `_test`.

Banking tests mock all Akahu HTTP responses and exercise read-only gates, encrypted/redacted credentials, OAuth state/restart/replay/expiry, eligible account selection, pagination recovery, duplicate imports, pending replacement, provider deletion/modification, partial/grouped/concurrent allocations, ambiguous suggestions, FX/fee separation, immutable approval snapshots, audited reversal, cooldown/backoff, revoked tokens and access control. The existing currency, invoice, Gmail, Shopify and stock-workflow suites run alongside them.
