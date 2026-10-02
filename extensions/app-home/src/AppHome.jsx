import {render} from 'preact';

/**
 * App landing page — what the app does and how a merchant configures a bundle.
 *
 * Static on purpose. A bundle is configured on the product page it belongs to,
 * not here, so this page only has to explain the model and point at the right
 * place. That also keeps it dependency-free: no router, no API calls.
 *
 * Screenshots belong in `assets/` (declared as `assets = "./assets"` in
 * `shopify.extension.toml`) and can be dropped into the last section.
 */

export default async () => {
  render(<Home />, document.body);
};

function Home() {
  return (
    <s-page heading="Product Bundler">
      <s-section heading="Sell bundled products without holding bundle inventory">
        <s-paragraph>
          Product Bundler lets a merchant sell several products as one. The buyer
          adds a single bundle to the cart, while Shopify receives the components
          that bundle is made of — so every component keeps its own price,
          inventory and fulfilment.
        </s-paragraph>
      </s-section>

      <s-section heading="Configuring a bundle">
        <s-ordered-list>
          <s-list-item>
            Open the product you want to sell as a bundle, in the Shopify admin.
          </s-list-item>
          <s-list-item>
            Add the Bundle block to the product page. Blocks are opt-in, so this
            is a one-time setup — one pin covers every product page.
          </s-list-item>
          <s-list-item>
            Choose Make this product a Bundle, then pick the products it contains
            and set the quantity of each.
          </s-list-item>
          <s-list-item>
            Save. The block then reports the bundle's contents, and Edit Bundle
            reopens the editor at any time.
          </s-list-item>
        </s-ordered-list>
      </s-section>

      <s-section heading="What the buyer sees">
        <s-paragraph>
          The bundle appears in the cart as the single product the buyer chose,
          with its components listed underneath. The bundle is charged at its own
          price, and each component is fulfilled and tracked separately.
        </s-paragraph>
      </s-section>

      <s-section heading="Screenshots">
        <s-paragraph>
          Screenshots of the bundle editor and the expanded cart will go here.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
