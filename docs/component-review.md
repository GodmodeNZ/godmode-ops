# Component review

Open **SKU Matching → Component matching review**. The initial queue prioritises draft invoice lines and candidates explicitly marked counted. Counted is a review-priority flag, not an inventory quantity.

CSV imports detect repeated SKU / Product Name header rows and retain only those two columns plus source row numbers. Quantity, cost, valuation and other cells are neither staged nor posted. A canonical import fingerprint prevents repeat imports when only obsolete quantity/cost cells change. Changed catalogue content creates a separate candidate batch so conflicts remain visible; it never creates an ERP SKU or merges records silently.

Review duplicate and missing codes, different descriptions and explicit model, colour, capacity and pack/kit conflicts. Specification extraction is conservative text checking, not authoritative manufacturer validation. Missing specifications need human verification. Exact identifiers are suggestions until confirmed; name similarity is never enough for automatic confirmation. A conflicting exact match remains unresolved.

The review joins draft supplier invoice lines with candidate codes, proposed components and confirmed exact Shopify variants. Search for another exact variant in the confirmation dialog if needed. Components may have no Shopify listing. Confirmations require a current row/invoice version. Specification exceptions require a written explanation and are audited. Kit differences do not convert quantities or unit costs.

Supplier CODE aliases are scoped to one supplier; several codes can identify one component. A conflicting alias replacement requires its current component ID and a correction note. **Apply confirmed code aliases** updates only unconfirmed lines on REVIEW invoices without a PO, and skips conflicting identifiers/specifications. Approved invoice records and snapshots remain immutable through these routes. No route approves an invoice, receives stock, updates costs or calls Shopify to change products.

Finished-PC variants are blocked from component links and SKU creation. Link them to an existing product with an active, non-empty BOM. Existing conflicting BOM mappings must be corrected explicitly in Settings. Finished-PC detection uses explicit product-type/title cues and existing build mappings; unusual or incomplete catalogue metadata must still be reviewed by a person.

The additive migration creates `CatalogueCandidate`; existing columns and rows are not rewritten. Only an authenticated administrator can write review/import/mapping changes. Private CSV, invoice files, runtime databases and verification reports belong in ignored private storage, never Git.

Tests cover repeated CSV headers, quoted descriptions, discarded quantities/costs, duplicate codes, missing identifiers, model/colour/capacity/pack conflicts, alias reuse, draft-only application, unchanged stock/costs and finished-PC separation. Existing invoice, currency, banking and operational tests remain part of the regression suite.

When no component exists, the confirmation dialog offers explicit creation of a reviewed code/name/family. It rejects normalized duplicate codes and accepts no quantities or costs. Creating that identity does not confirm an invoice mapping; select it and review the mapping separately.

Unconfirmed spreadsheet and Shopify candidates are also compared directly with source descriptions, explicit MPNs, codes and barcodes before ERP components exist. Matching model tokens and name similarity are suggestions only; their conflicting specifications are displayed. Review rows are paginated.
