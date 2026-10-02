import "@shopify/ui-extensions/preact";
import {render} from 'preact';
import {useEffect, useState} from 'preact/hooks';

/**
 * Admin action for configuring a bundle from the product details page.
 *
 * Writes the app-owned `json` metafield `$app` / `bundle_components` on the
 * product, which is what `cart-transformer-extension` reads to decide how to
 * expand the cart line. The two halves are coupled by those two strings alone —
 * rename either and the function silently stops matching.
 *
 * The metafield shape is:
 *   { "components": [ { "id": "gid://shopify/ProductVariant/1", "quantity": 2 } ] }
 *
 * No `price` is ever written: the bundle is always charged at the parent
 * product's price.
 */

const METAFIELD_NAMESPACE = "$app";
const METAFIELD_KEY = "bundle_components";
const METAFIELD_TYPE = "json";

export default async () => {
  render(<Extension />, document.body);
};

/**
 * Direct Admin API access — the extension automatically adds auth headers.
 *
 * Returns the `data` field of the response. The shape depends entirely on the
 * caller's query, so it is deliberately untyped here; each query below documents
 * what it expects to read back.
 *
 * @param {string} query GraphQL document.
 * @param {Record<string, unknown>} [variables]
 * @returns {Promise<any>}
 */
async function gql(query, variables) {
  const res = await fetch("shopify:admin/api/graphql.json", {
    method: "POST",
    body: JSON.stringify({query, variables}),
  });

  /** @type {{errors?: Array<{message: string}>, data?: any}} */
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  return json.data;
}

const READ_PRODUCT = `
  query Product($id: ID!) {
    product(id: $id) {
      title
      metafield(namespace: "${METAFIELD_NAMESPACE}", key: "${METAFIELD_KEY}") {
        id
        jsonValue
      }
    }
  }
`;

const READ_VARIANTS = `
  query Variants($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        title
        product {
          id
          title
          variants(first: 100) {
            nodes {
              id
              title
            }
          }
        }
      }
    }
  }
`;

/**
 * Resolves the products returned by the product picker into their variants.
 *
 * The picker hands back products, because that is what carries a readable name,
 * but the cart transform expands to **variants** — so the variant has to be
 * resolved before anything can be stored in the metafield.
 */
const READ_PRODUCTS = `
  query Products($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        variants(first: 100) {
          nodes {
            id
            title
          }
        }
      }
    }
  }
`;

const SAVE_COMPONENTS = `
  mutation SaveComponents($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const DELETE_COMPONENTS = `
  mutation DeleteComponents($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields {
        ownerId
        namespace
        key
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * A component as stored in the metafield (no label), and as held in state.
 *
 * `id` is always a **variant** GID — that is what the cart transform expands to
 * and what the metafield stores. `options` are the sibling variants of the same
 * product, so a row can offer a chooser when the product has more than one.
 *
 * @typedef {{id: string, title: string}} VariantOption
 * @typedef {{id: string, quantity: number}} ComponentInput
 * @typedef {{id: string, quantity: number, label: string, options: VariantOption[]}} BundleRow
 */

/**
 * Turns a list of `{ id, quantity }` into rows carrying a human label and, where
 * the product has alternatives, the variants to choose between.
 *
 * Names are resolved in one round trip rather than stored, so the rows stay
 * correct if a product or variant is renamed after the bundle was saved.
 *
 * @param {ComponentInput[]} components
 * @returns {Promise<BundleRow[]>}
 */
async function withLabels(components) {
  if (components.length === 0) return [];

  // `gql` returns the raw `data` field, so the expected shape is asserted here.
  const data =
    /** @type {{nodes?: Array<{id: string, title: string, product?: {id?: string, title?: string, variants?: {nodes?: Array<{id: string, title: string}> | null} | null} | null}> | null}} */ (
      await gql(READ_VARIANTS, {ids: components.map((c) => c.id)})
    );
  const byId = new Map((data.nodes ?? []).filter(Boolean).map((n) => [n.id, n]));

  return components.map((component) => {
    const product = byId.get(component.id)?.product;

    // The product names the row. A single-variant product has no variant name to
    // show ("Default Title" is a placeholder), and a multi-variant one offers its
    // alternatives through `options` instead of repeating one in the label.
    return {
      id: component.id,
      quantity: component.quantity > 0 ? component.quantity : 1,
      label: product?.title || component.id,
      options: product?.variants?.nodes ?? [],
    };
  });
}

function Extension() {
  const {close, data} = shopify;
  const productId = data.selected[0].id;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Explicit initial-value types: `useState(null)` otherwise narrows to `null`
  // and `useState([])` to `never[]`, making every later update a type error.
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [productTitle, setProductTitle] = useState("");
  const [components, setComponents] = useState(/** @type {BundleRow[]} */ ([]));
  const [isBundle, setIsBundle] = useState(false);

  useEffect(() => {
    (async function loadBundle() {
      try {
        const data =
          /** @type {{product?: {title?: string, metafield?: {jsonValue?: {components?: Array<{id: string, quantity: number}>} | null} | null} | null}} */ (
            await gql(READ_PRODUCT, {id: productId})
          );
        const product = data?.product;
        setProductTitle(product?.title ?? "");

        const raw = product?.metafield?.jsonValue?.components ?? [];
        setIsBundle(raw.length > 0);
        setComponents(await withLabels(raw));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [productId]);

  /** Opens the native picker and appends any variants not already present. */
  async function addVariants() {
    setError(null);
    try {
      // Product-level picking, deliberately. Shopify titles the single variant of
      // an option-less product "Default Title", and the picker renders that as a
      // blank row — so a merchant picking variants cannot tell those products
      // apart. Products always have a real name.
      const picked = await shopify.resourcePicker({
        type: "product",
        multiple: true,
        action: "add",
      });
      if (!picked?.length) return;

      // The transform stores variants, so resolve each picked product's variant.
      const products =
        /** @type {{nodes?: Array<{id: string, title: string, variants?: {nodes?: Array<{id: string, title: string}> | null} | null} | null> | null}} */ (
          await gql(READ_PRODUCTS, {ids: picked.map((p) => p.id)})
        );

      const existing = new Set(components.map((c) => c.id));
      // `nodes` can hold nulls for ids that no longer resolve to a product.
      const resolved =
        /** @type {Array<{id: string, title: string, variants?: {nodes?: Array<{id: string, title: string}> | null} | null}>} */ (
          (products.nodes ?? []).filter(Boolean)
        );

      const additions = resolved.flatMap((product) => {
        // Default to the first variant. Products with more than one get a
        // chooser on the row (filled in by `withLabels`) to pick the right one.
        const variant = product.variants?.nodes?.[0];
        if (!variant || existing.has(variant.id)) return [];
        return [{id: variant.id, quantity: 1}];
      });

      if (additions.length === 0) return;
      setComponents(await withLabels([...components, ...additions]));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // `s-number-field` reports its value as a string, so accept both and coerce.
  /** @param {string} id @param {number | string} quantity */
  function setQuantity(id, quantity) {
    const parsed = Math.max(1, Math.floor(Number(quantity)) || 1);
    setComponents((rows) =>
      rows.map((row) => (row.id === id ? {...row, quantity: parsed} : row)),
    );
  }

  /** @param {string} id */
  function removeComponent(id) {
    setComponents((rows) => rows.filter((row) => row.id !== id));
  }

  /**
   * Switches a row to another variant of the same product.
   *
   * Only the variant changes: the label is the product's, and `options` still
   * describes that same product, so the chooser stays populated.
   *
   * @param {string} id Current variant GID.
   * @param {string} nextId Variant GID to switch to.
   */
  function setVariant(id, nextId) {
    setComponents((rows) => {
      // Refuse a variant another row already uses, or the same variant would be
      // expanded twice.
      if (rows.some((row) => row.id === nextId)) return rows;
      return rows.map((row) => (row.id === id ? {...row, id: nextId} : row));
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const value = JSON.stringify({
        components: components.map((c) => ({id: c.id, quantity: c.quantity})),
      });

      const result = await gql(SAVE_COMPONENTS, {
        metafields: [
          {
            ownerId: productId,
            namespace: METAFIELD_NAMESPACE,
            key: METAFIELD_KEY,
            type: METAFIELD_TYPE,
            value,
          },
        ],
      });

      /** @type {Array<{message: string}>} */
      const userErrors = result.metafieldsSet.userErrors ?? [];
      if (userErrors.length > 0) {
        throw new Error(userErrors.map((e) => e.message).join("; "));
      }
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  async function unbundle() {
    setSaving(true);
    setError(null);
    try {
      const result = await gql(DELETE_COMPONENTS, {
        metafields: [
          {
            ownerId: productId,
            namespace: METAFIELD_NAMESPACE,
            key: METAFIELD_KEY,
          },
        ],
      });

      /** @type {Array<{message: string}>} */
      const userErrors = result.metafieldsDelete.userErrors ?? [];
      if (userErrors.length > 0) {
        throw new Error(userErrors.map((e) => e.message).join("; "));
      }
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }

  const heading = isBundle
    ? `Edit bundle${productTitle ? ` — ${productTitle}` : ""}`
    : `Make this product a Bundle${productTitle ? ` — ${productTitle}` : ""}`;

  if (loading) {
    return (
      <s-admin-action heading={heading}>
        <s-text>Loading…</s-text>
      </s-admin-action>
    );
  }

  return (
    <s-admin-action heading={heading}>
      <s-stack direction="block" gap="base">
        {error && <s-banner tone="critical">{error}</s-banner>}

        {components.length === 0 ? (
          <s-text>
            This product isn't a bundle yet. Add the products it should expand
            into, then save. Buyers will be charged this product's price.
          </s-text>
        ) : (
          components.map((component) => (
            <s-stack
              key={component.id}
              direction="inline"
              gap="base"
              alignItems="center"
            >
              <s-text>{component.label}</s-text>
              {component.options.length > 1 ? (
                <s-select
                  label="Variant"
                  labelAccessibilityVisibility="exclusive"
                  value={component.id}
                  onChange={(event) =>
                    setVariant(component.id, event.currentTarget.value)
                  }
                >
                  {component.options.map((option) => (
                    <s-option key={option.id} value={option.id}>
                      {option.title}
                    </s-option>
                  ))}
                </s-select>
              ) : null}
              <s-number-field
                label="Quantity"
                labelAccessibilityVisibility="exclusive"
                value={String(component.quantity)}
                min={1}
                onChange={(event) =>
                  setQuantity(component.id, event.currentTarget.value)
                }
              />
              <s-button
                variant="tertiary"
                tone="critical"
                onClick={() => removeComponent(component.id)}
              >
                Remove
              </s-button>
            </s-stack>
          ))
        )}

        <s-button onClick={addVariants}>Add products</s-button>
      </s-stack>

      <s-button
        slot="primary-action"
        variant="primary"
        loading={saving}
        disabled={components.length === 0}
        onClick={save}
      >
        {isBundle ? "Save changes" : "Save as bundle"}
      </s-button>

      {isBundle && (
        <s-button
          slot="secondary-actions"
          tone="critical"
          disabled={saving}
          onClick={unbundle}
        >
          Unbundle
        </s-button>
      )}

      <s-button slot="secondary-actions" disabled={saving} onClick={close}>
        Cancel
      </s-button>
    </s-admin-action>
  );
}
