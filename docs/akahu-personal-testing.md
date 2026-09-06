# Isolated Akahu personal-app testing

This adapter is for permitted non-production testing of the user's own Akahu account. It does not replace commercial full-app onboarding. See [Akahu personal apps](https://developers.akahu.nz/docs/personal-apps): an App ID Token and User Access Token are required; no OAuth exchange or callback is used. Personal apps have daily provider refreshes and a one-hour manual refresh rest period. This adapter never requests a refresh or payment.

## Isolation requirements

Use a separate checkout and a newly created database named `godmode_akahu_personal_test_<timestamp>`. Apply the existing additive migrations with `prisma migrate deploy`; do not reset, seed or migrate the live database. The local installation's database name may contain `test` even when it holds live business records: that name is not sufficient evidence of isolation.

Required server environment:

```
AKAHU_PERSONAL_TEST=true
NODE_ENV=test
API_HOST=127.0.0.1
API_PORT=4001
WEB_ORIGIN=http://127.0.0.1:4001
COOKIE_SECURE=false
ERP_DATA_DIR=<private test-only directory outside Git>
DATABASE_URL=<new isolated database URL>
```

Generate a fresh test administrator and encryption key. Never reuse live login hashes, sessions, Gmail/Shopify credentials or the live encryption key. Restrict the private directory with Windows ACLs; POSIX mode flags alone do not protect Windows files. Database credentials, login credentials, encryption keys and bank data must remain outside Git and logs. The test server disables request logging, mailbox polling and banking polling.

The dedicated loopback hostname separates its authentication cookie from the live ERP at `localhost:4000`. Do not share this test instance or expose it through a tunnel.

## Local token entry and test

1. Open `http://127.0.0.1:4001/?section=Banking` and sign in with the separate test administrator.
2. In **ISOLATED PERSONAL-APP TEST**, enter the App ID Token and User Access Token locally. Never paste either token into chat, command arguments or source files. Both fields are password inputs, cleared when submitted. Values are encrypted server-side using AES-256-GCM and are not returned by status endpoints.
3. Set a completed UTC window of no more than seven days. Start is inclusive; end is exclusive. Consider the Auckland/UTC date difference. Save, load accounts, select exactly one eligible BNZ account and save selection. The server rejects multiple accounts and scheduled syncing.
4. Fetch cached transactions. Each click processes at most three pages. Click again to resume if needed; progress is persisted. Current pending transactions are deliberately not fetched in this historical test. Rows outside the configured time window are rejected.
5. Compare posted IDs, amounts, currency, timestamps and references against source records in a private local report. Repeat the same import and verify stable IDs, row count and revisions. If the real range fits on one page, report real pagination as unexercised; mock multipage coverage is separate evidence.
6. Use invoice metadata copies explicitly marked `ISOLATED_TEST_COPY`, with no live payment, attachment, purchase-order or inventory relationships. Suggestions do not approve invoices or record payments. Confirm test partial/grouped allocations only in this database; check limits and audited reversals. Distinguish artificial allocation exercises from verified real invoice matches.
7. Refresh the test page and verify scheduled syncing remains off. Disconnect locally when finished; this deletes the locally stored personal tokens without revoking the user's app. The user can revoke it at Akahu independently.

## Activation boundary

Do not promote this database, its allocations or personal tokens into production. Commercial activation requires approved full-app access, separate encrypted full-app credentials, read-only scopes, a registered HTTPS callback, secure cookies, and the commercial gate described in the main Akahu onboarding guide. Real bank testing is incomplete until credentials are supplied, an account is selected, and source amounts/dates and duplicate behaviour have been verified.
