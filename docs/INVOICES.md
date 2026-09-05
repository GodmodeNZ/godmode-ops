# Invoices and SKU matching

## Update your Windows test copy

Close the running ERP window. Extract the updated branch into a temporary folder and copy its application files over your existing ERP folder. Keep the existing `.env` and `.data` folders. Run `Start-Godmode-Ops.cmd` again; it installs the new dependencies and applies the additive invoice migration. Your existing stock, builds and login remain in place.

## Connect Shopify on Windows

Double-click `Connect-Shopify.cmd`. The helper installs Shopify CLI 4.7.1 into `.data/shopify-cli`, opens Shopify sign-in and requests read access to products, orders and customers. Approve the connection to Godmode (`pcs-for-you.myshopify.com`). The helper verifies the store before writing a local connection marker. Shopify keeps the credential in its own local credential store.

Return to the ERP, refresh the dashboard and open **SKU Matching → Sync catalogue**. You can sync the catalogue in test mode; live order import remains disabled there. If the Shopify session expires, rerun `Connect-Shopify.cmd`. The ERP does not attempt an interactive sign-in from a background request.

For a permanent server installation, use **SKU Matching → Connect Shopify** with an installed app's client ID/secret, or an existing access token. Product reads require `read_products`; the existing order import also reads orders and customer information. The server verifies the store and product read access before saving encrypted credentials. The chat's Shopify connection does not automatically grant the ERP access on your PC.

A catalogue snapshot can also be imported with **Import catalogue JSON**. The supplied snapshot contains product/variant names, IDs, status, SKUs and barcodes; it contains no customer orders or credentials. This is a point-in-time catalogue, not a live connection. A complete sync marks absent variants as missing and preserves their confirmed links for review. Older snapshots cannot overwrite a newer catalogue.

## Review product matches

**SKU Matching** shows:

- Exact Shopify product and variant, its status, SKU and barcode, with an Admin link.
- Linked ERP component name and code.
- The matching reason, candidate components and who confirmed the link.
- Supplier-specific aliases and controls to correct or remove them.
- Existing Shopify sales-product mappings to ERP build products/BOMs.

An exact SKU, barcode or previously imported Shopify variant ID proposes a component. You explicitly confirm that link. A complete PC's sales/BOM mapping is separate from component-stock matching; don't create an inventory component for a whole PC just to resolve an invoice.

For invoice lines, candidates come from confirmed supplier aliases, supplier part codes, ERP codes and identifiers on confirmed Shopify links. Any conflicting exact identifiers block automatic selection. Similar names are suggestions only. Check model, capacity, colour and units per kit before confirming. A 2-stick RAM kit represented by one ERP SKU must be invoiced as one kit; pack conversions are manual and must be reflected in quantities and unit costs.

## Import and approve invoices

1. Open **Invoices** and upload a PDF, CSV, TXT or saved EML email (8 MB maximum), or pull emails after connecting a mailbox.
2. Review the original extracted text and download the preserved source document when needed. Original files are authenticated downloads, never public static assets.
3. Choose the supplier and verify invoice number, dates, currency, amounts and each line. For CSV, supported headings include `description,supplierCode,barcode,quantity,unitCost,lineTotal`.
4. Confirm each line's ERP SKU. Linked Shopify variants and candidate reasons appear alongside it. Save to refresh matches and validation. Changing the supplier clears line confirmations.
5. Enter the line subtotal excluding GST, total GST/tax, freight excluding GST, and final invoice total. These must reconcile. Discounts must be represented in the net line costs; unrelated fees require review rather than forcing a false component match.
6. Link an existing PO if applicable and review quantity/price differences, then approve. Approval can remember descriptions and supplier codes as supplier-specific aliases. Existing conflicting aliases must be corrected separately or left unchanged.
7. If there is no PO, an approved invoice can create a draft PO. Use Purchasing to mark it ordered, then Receiving to record the physical delivery and its serial numbers.

Invoice approval never increases inventory. Source-byte hashes prevent exact duplicate imports. Supplier + normalized invoice number prevents duplicate approvals even when the supplier sends a different PDF. Approved invoices retain the SKU/Shopify names and identifiers as they were at approval; later mapping changes do not rewrite that history. Concurrent edits require reopening the latest version.

Text extraction is deliberately conservative. CSV columns and text rows ending in quantity, unit price and line total are recognised. Scanned PDFs, unusual layouts, ambiguous dates and unrecognised fields require manual entry. Nothing is silently approved. Credit notes and negative-value invoices are not supported by this purchase-invoice workflow.

## Connect email

**Invoices → Configure email** supports Google Workspace/Gmail and Microsoft 365/Outlook. Choose a dedicated Invoices label/folder, a starting date and optional supplier sender addresses. The initial setup requires an application client ID/secret from the chosen email provider; copy the exact redirect address displayed in the ERP to that application's allowed redirect URLs. Gmail needs the Gmail API enabled. Microsoft needs delegated Mail.Read plus offline access. Use a top-level Outlook folder (or Inbox).

Save, select **Connect email**, then approve read access in your browser. The connection uses a short-lived state, a browser-bound callback cookie and PKCE. Access/refresh credentials are encrypted on the server. Pull invoice emails with the button; imports run in batches of up to 50 messages. If more remain, pull the next batch. Failed pages remain retryable and already imported attachments are deduplicated. With several supported attachments, mailbox imports create one draft per attachment. A manually uploaded EML with multiple invoice attachments flags them for individual import.

The mailbox integration only reads messages. It does not send, move, delete or mark emails as read. It is a manual pull workflow in this release; no hidden scheduled job is enabled. Email provider consent and a live mailbox could not be completed from the development environment because the provider/account has not been specified.

## Credentials and backups

Saved app/mailbox credentials use AES-256-GCM. The encryption key is generated in `.data/integration.key` (or supplied as the 64-hex-character `INTEGRATION_ENCRYPTION_KEY`). Preserve the original key together with database backups; the database alone cannot decrypt saved connections. Docker mounts a persistent `app_data` volume for this key. `.data`, local credentials, email files and catalogue exports must never be committed to the public repository.

## Verification

Automated tests cover conservative extraction including a text PDF, duplicate files/numbers, conflicting aliases, optimistic edit conflicts, line/total validation, approval without stock receipt, immutable approval snapshots, PO creation, credential encryption, read-only permissions, mocked Shopify verification, and mocked Gmail consent/pull/replay. The Windows CI job also checks query-file handling and CLI response parsing. Live mailbox consent and real local Shopify sign-in require the user's accounts and computer; they are not represented as completed by these mocks.

Official references: [Shopify store commands](https://github.com/Shopify/cli/blob/main/packages/cli/README.md#shopify-store-auth), [Shopify product variants](https://shopify.dev/docs/api/admin-graphql/2026-07/queries/productVariants), [Google email consent](https://developers.google.com/identity/protocols/oauth2/web-server), [Microsoft email consent](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow), [MailParser](https://nodemailer.com/extras/mailparser).
