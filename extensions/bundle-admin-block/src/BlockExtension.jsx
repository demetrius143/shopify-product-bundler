import "@shopify/ui-extensions/preact";
import {render} from 'preact';
import {useEffect, useState} from 'preact/hooks';

/**
 * Product details **block** — the pinned card that tells the merchant whether
 * this product is a bundle and hands editing off to the action extension.
 *
 * Deliberately thin: it reads the status and navigates. Its only write is
 * "Unbundle", which is a single metafield delete. Everything else (choosing
 * components, saving) lives in `bundle-admin-action` so there is one editor.
 *
 * The block/action handoff uses the **extension protocol**:
 *
 *   extension:<action-handle>/<action-target>
 *
 * Only navigation between extensions on the **same resource page** is
 * supported, which is exactly this pair — product details block to product
 * details action. The action is opened as a modal, and the page refreshes when
 * it closes.
 *
 * The metafield contract below is shared with `bundle-admin-action` and read by
 * `cart-transformer-extension`; those two strings are the entire coupling.
 */

const METAFIELD_NAMESPACE = "$app";
const METAFIELD_KEY = "bundle_components";

/**
 * Handle and target of the sibling action extension, both from
 * `extensions/bundle-admin-action/shopify.extension.toml`. Rename the handle
 * there and this string must change with it.
 */
const ACTION_URL =
  "extension:bundle-admin-action/admin.product-details.action.render";

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

const READ_STATUS = `
  query BundleStatus($id: ID!) {
    product(id: $id) {
      metafield(namespace: "${METAFIELD_NAMESPACE}", key: "${METAFIELD_KEY}") {
        id
        jsonValue
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

function Extension() {
  const {data, navigation} = shopify;
  const productId = data.selected[0].id;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [componentCount, setComponentCount] = useState(0);

  useEffect(() => {
    (async function loadStatus() {
      try {
        const result =
          /** @type {{product?: {metafield?: {jsonValue?: {components?: Array<{id: string, quantity: number}>} | null} | null} | null}} */ (
            await gql(READ_STATUS, {id: productId})
          );

        // A metafield holding an empty component list is not a bundle.
        setComponentCount(
          result?.product?.metafield?.jsonValue?.components?.length ?? 0,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [productId]);

  /** Opens the action extension's modal over this page. */
  function openEditor() {
    navigation.navigate(ACTION_URL);
  }

  /** Removes the config metafield entirely, turning the product back into a plain one. */
  async function unbundle() {
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
      setComponentCount(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const isBundle = componentCount > 0;

  return (
    <s-admin-block heading="Bundle">
      <s-stack direction="block" gap="base">
        {error && <s-banner tone="critical">{error}</s-banner>}

        {loading ? (
          <s-text>Checking bundle status…</s-text>
        ) : isBundle ? (
          <>
            <s-text>
              This product is a bundle: it expands into {componentCount}{" "}
              {componentCount === 1 ? "component" : "components"} and buyers are
              charged this product's price.
            </s-text>
            <s-stack direction="inline" gap="base">
              <s-button onClick={openEditor}>Edit Bundle</s-button>
              <s-button variant="tertiary" tone="critical" onClick={unbundle}>
                Unbundle
              </s-button>
            </s-stack>
          </>
        ) : (
          <>
            <s-text>This product isn't a bundle yet.</s-text>
            <s-button onClick={openEditor}>Make this product a Bundle</s-button>
          </>
        )}
      </s-stack>
    </s-admin-block>
  );
}
