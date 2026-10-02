# AGENTS.md

## What this repo is

A **learning** repo for Shopify app development. The goal is to practise the whole loop: scaffold an
app, add extensions, write a Shopify Function, then do the store plumbing that actually makes it go
live (scopes, app-owned metafields, function registration).

It is not a product. Prefer the clear, well-commented implementation over cleverness, and keep the
manual store steps documented — they are the part that is easiest to forget.

## Working on Shopify platform code

Use the [Shopify AI Toolkit](https://shopify.dev/docs/apps/build/ai-toolkit) for all Shopify API and
platform work. If missing, install it in the agent host per that page (or
`npx skills add Shopify/shopify-ai-toolkit --list` for skill-compatible hosts) — do not add tooling to
this repo.

Practical workflow:

- Search the docs before writing API code.
- Validate generated GraphQL. For the cart transform target the validator API name is
  `functions_cart_transform`, **not** `functions`.
- **Never run `shopify app deploy`.** Releases are the developer's call.
- Never write `ownerId`/variant ids from memory — query the store for real GIDs.

## The first feature: `cart-transformer-extension`

A Rust Shopify Function on the `cart.transform.run` target that expands a bundle into its components.

**Deliberate shape — keep it this way unless there is a concrete reason not to:**

- the **bundle is a product** (the container the buyer adds to the cart);
- its components are **fixed variants with a quantity** — no buyer choice, no options;
- the config is one app-owned `json` metafield on that product (`$app` / `bundle_components`).

Shopify documents a fuller platform bundle convention (`component_reference` + `component_quantities`
on the bundle *variant*, plus `component_parents` on each component) that unlocks
sellable-quantity/oversell protection, Liquid `item_components`, Storefront API bundle support and
`linesMerge`. **We intentionally do not use it** — a product-level metafield with fixed variants keeps
both the config and the function small. The trade-offs are listed in the README; do not "fix" this by
migrating unless those specific behaviours are actually needed.

Consequence of the product-level choice: every variant of the bundle product is treated as a bundle,
so components must come from a **different product**.

### How the extension is wired

Five files define the whole thing; the README has the diagram.

- `shopify.extension.toml` declares the target, the input query, the build command, and
  `export = "cart_transform_run"` — that string **must match the Rust function name**. It is how
  Shopify knows what to call.
- `#[typegen("schema.graphql")]` in `main.rs` reads the schema plus the query and **generates the
  Rust types at compile time**, so editing the query requires a rebuild. All logic belongs in
  `cart_transform_run.rs`; `main.rs`'s `main()` deliberately aborts, because Shopify calls the export
  rather than a program entry point.
- Shopify calls the function on **every cart change with the entire cart**. It has no notion of
  bundles — deciding which lines qualify is our code's job.
- The function returns a **description of the desired cart**, not imperative commands. Shopify decides
  whether to honour it, which is why a green local suite can still be rejected server-side.

This replaced an earlier attempt at "buy X get Y free" promotions — see the per-unit gotcha below for
why that shape does not fit `lineExpand`. See the README for the config contract and activation steps.

## Hard-won gotchas

### Store plumbing — every one of these fails *silently*

- `shopify.app.toml` needs `scopes = "write_cart_transforms,write_products"`. Without it the function
  cannot be registered at all.
- A cart transform is **inert until registered** with
  `cartTransformCreate(functionHandle: "cart-transformer-extension")`. A deployed-but-unregistered
  function looks exactly like a working one that found nothing to do.
- `functionHandle` resolves in the **app's** context only. `shopify store execute` (CLI store auth)
  authenticates as the CLI's *own* app, so it cannot see this app's functions, `$app` metafields, or
  `cartTransforms` — they all come back empty/null. Use the app's GraphiQL console from
  `shopify app dev` (port 3457, printed in the dev output).
- `metafieldsSet` `ownerId` must be a real resource GID in numeric form
  (`gid://shopify/Product/123`, `gid://shopify/Shop/82282873055`) — a `.myshopify.com` handle fails
  with `Owner does not exist`.
- Writing `namespace: "$app"` stores it as `app--<appId>`; the function's `product.bundleComponents`
  metafield resolves to that same record. The config metafield lives on the **bundle product**
  (`$app` / `bundle_components`), so `ownerId` is the product's GID.
- Malformed config JSON reads as an empty rule set, so the function emits no operations —
  indistinguishable from it not running. Register with `blockOnFailure: true` while iterating so
  failures are loud instead of silent.

### Shopify Functions + Rust

- **`expandedCartItems` quantities are PER UNIT of the cart line.** The operation defines a bundle's
  composition for ONE unit, and Shopify multiplies every quantity by the line quantity. Components
  `(2, 1)` on a line of 3 render as `× 6` and `× 3`, and the line total becomes `3 ×` the component
  sum — the buyer gets charged for 6 units instead of 2. Consequence: anything expressed here must be
  a whole number **per single unit**, so a promotion like "1 free per 3 units" is not expressible at
  all, and neither is auto-adding a free *different* product on a threshold. That is why this
  function is a bundle expansion rather than a promotion engine.
- **`lineExpand` must not mix customized and non-customized component prices.** Price *every* expanded
  item or none. Violating this returns a generic `{"errors":"Cart Error"}` on `/cart/change`, and it
  is enforced **only server-side** — a green local test suite does not rule it out. To keep the paid
  portion unchanged, re-state the line's own price from `cost.amountPerQuantity.amount` (already
  presentment currency, so no `presentmentCurrencyRate` maths; `Decimal` is `Copy`).
- Other `lineExpand` invalid scenarios: negative component quantity, the line to be expanded not
  existing, non-existent component variant ids, negative component prices, and returning **both**
  `ExpandedItem.price` and the group-level `ExpandOperation.price`.
- Name the Rust query operation **`Input`** so generated types land at `schema::<module>::input::...`.
- **Query types** expose accessor **methods** returning references (`line.quantity()` → `&i32`, so
  deref with `*`). **Result/output types** (`schema::Operation`, `schema::ExpandedItem`) expose
  **public fields** instead.
- The `Deserialize` derive has **no implicit default**: every optional config field needs
  `#[shopify_function(default)]` plus `#[derive(Default)]` on the struct, otherwise a missing JSON key
  reads as `null` and fails with `read::Error::InvalidType`.
- That derive does not support enums — if a config needs alternatives, use a flat struct (a
  discriminator `String` plus optional fields) rather than a Rust enum.
- `custom_scalar_overrides` paths start with the GraphQL **operation** name:
  `"Input.cart.lines.merchandise.product.bundleComponents.jsonValue" => super::<module>::Configuration`.
- `expand` works on all plans; `lineUpdate` is Shopify Plus only (dev stores count as Plus for it).

### Toolchain

- `shopify app dev` shells out to `cargo`. If the terminal predates the rustup install it fails with
  `spawn cargo ENOENT`. Open a new terminal or `source "$HOME/.cargo/env"`; check `command -v cargo`.
- Run `npm install` at the repo root before `vitest` — extensions are npm workspaces and vitest is
  hoisted there. Otherwise `npx vitest` hangs on an install prompt.
- Integration tests diff function output against `tests/fixtures/*.json` **exactly**, so changing the
  emitted JSON means updating the fixtures. The harness also validates fixtures against the query, so
  a selection removed from the query must be removed from fixtures too.
- Verifying on a store: the three outcomes are distinguishable only because registration uses
  `blockOnFailure: true`. A split cart line = working. An error = the function ran and Shopify
  rejected the operation. **Silence = not running** (stale WASM, unregistered transform, or no
  readable metafield on that product) — note this is also what a correct function does when a product
  has no bundle config, so silence proves nothing on its own.
