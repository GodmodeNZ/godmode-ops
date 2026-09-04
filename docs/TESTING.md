# Test walkthrough

Start the application with `Start-Godmode-Ops.cmd`. Use the login shown in the command window. All sample records start with `TEST` and all component prices are illustrative.

1. **Overview:** confirm the three sample builds appear: queued, reserved and in progress.
2. **Receiving:** open `TEST-DEMO-PO1`. Receive one CPU using a new serial such as `TEST-DELIVERY-CPU-001`, leaving other quantities at zero. The PO should show partially received. Receive its remaining quantities later.
3. **Inventory:** search for the CPU. Verify on-hand, reserved and available quantities. Open Serials. Add a barcode or create a new component family/SKU if desired.
4. **Products & BOMs:** open Test Colossus. Create a new BOM version. Existing builds must retain their previous version.
5. **Production:** open `TEST-DEMO-1`. Reserve its parts from Main warehouse. Reopen it and start assembly.
6. **QA:** record a failed check and confirm completion remains unavailable. Record all six checks as passed, then complete the PC with a unique Unit ID.
7. **Units & Dispatch:** open the new PC. Check the installed component serials, costs and build events. Print the build record. Record a courier and test tracking number.
8. **Orders:** create a new paid order for Test Colossus. Resolve and reserve it, then follow the resulting build. In Settings you can also import a sample Shopify-format order without contacting Shopify.
9. **Purchasing:** raise a component's safety stock in Inventory, add/update a supplier quote and create shortage drafts. Repeating the action should not create unnecessary duplicate drafts.
10. **Service:** open a ticket against a finished PC, update the diagnosis and close it with a resolution. An open ticket prevents dispatch.
11. **Reports / History:** inspect costs and export CSVs. Confirm stock movements include who recorded them and their reason/reference.
12. **Settings:** add a viewer account. Sign in as that account and confirm it can read records but cannot change them.

The test database persists between sessions. Re-running the launcher does not refill stock you have consumed and does not reset your changes. Keep `.env` and `.data` when updating the code.

## Automated suite

The suite checks authentication, rejected origins, viewer access, barcode lookup, BOM validation, serialized receiving, duplicate receipts, PO receipt bounds, inventory reservations, concurrent allocation of the final serial, immutable ledger, QA gates, completion cost/serial history, transfers, service/dispatch, Shopify replay safety, paid-order gating, changed orders, signed webhooks and failed-event replay.

A PostgreSQL 17 service is configured in `.github/workflows/ci.yml`. Compilation is checked for both API and frontend. A second job runs the Windows launcher twice: fresh database setup, migrations, sample data, build, authenticated HTTP checks, clean shutdown and restart with saved data. Browser interaction tests have not been performed; use the walkthrough above for hands-on acceptance testing.
