# Approved internal personal-app bank feeds

This mode supports a personal app where Akahu has confirmed use for the owner's own business accounts. It is not permission to access customers' accounts or offer a third-party banking service. Review provider correspondence privately before activation; do not commit it or account identifiers.

## Server configuration

Set `AKAHU_INTERNAL_APPROVED=true` only after reviewing permission. Set `AKAHU_INTERNAL_APP_SHA256` to the SHA-256 fingerprint of the approved App ID Token and `AKAHU_INTERNAL_ACCOUNT_ID` to the single approved account ID. These belong in private server configuration, not Git. This mode is distinct from `PERSONAL_TEST`; the isolated adapter remains test-only. Full-app OAuth gates are unchanged.

Use HTTPS and secure cookies for remote access. On the existing localhost HTTP ERP, banking requests are restricted to loopback clients without changing other integration listeners. Tokens remain server-side AES-256-GCM encrypted with the existing integration key. Never log request bodies or tokens. Enter App ID Token and User Access Token through Banking's password fields; no App Secret, OAuth exchange or callback registration is needed.

Back up the live database and encryption key first. Configure the approved app, discover accounts and select the approved account. Other accounts cannot be selected or fetched through this mode. Import a small range from Akahu through the normal persisted pagination/ID upsert pipeline. Never copy test invoices, transactions or allocations into live data. Compare original amount/currency/date/IDs and repeat the import; verify unchanged transaction counts/revisions before scheduling. The server requires two completed imports since configuration before allowing scheduling.

## Scheduling and limits

Cached imports run daily while the ERP runs. Each worker batch processes at most three pages, persists progress and resumes safely; 429 Retry-After and revoked-token behavior are retained. Cached reads do not request a bank refresh. Personal apps have daily provider refreshes and a one-hour manual refresh rest period; this adapter does not expose manual refresh at all. Last successful import, account freshness, progress and sanitized errors are shown in Banking. An interrupted active import can resume even when scheduling is off; Cancel unfinished import stops it.

Every invoice allocation requires human confirmation. Ambiguous suggestions, including Amazon purchases, remain unconfirmed. Reconciliation does not approve invoices, change approved exchange rates/stock valuation or receive stock. Local disconnect stops syncing and deletes stored tokens; revoke the personal app independently at my.akahu.nz if desired.

Sources: [Personal apps](https://developers.akahu.nz/docs/personal-apps), [Data refreshes](https://developers.akahu.nz/docs/data-refreshes). No changes to provider terms or published limits are implied by this configuration.
