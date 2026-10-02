use crate::schema;
use shopify_function::prelude::*;
use shopify_function::Result;

/// The bundle definition, stored as a `json` metafield on the bundle **product**
/// (namespace `$app`, key `bundle_components`).
///
/// ```json
/// {
///   "components": [
///     { "id": "gid://shopify/ProductVariant/111", "quantity": 2, "price": "24.99" },
///     { "id": "gid://shopify/ProductVariant/222", "quantity": 1 }
///   ]
/// }
/// ```
///
/// `components` is the recipe for **one** unit of the bundle. Shopify multiplies
/// every quantity here by the cart line's quantity, so a buyer with 3 bundles
/// receives 3 × each component.
///
/// `#[derive(Default)]` supplies a per-field default and `#[shopify_function(default)]`
/// makes the derive fall back to it when a key is missing or `null` — without it a
/// missing key reads as `null` and fails with `read::Error::InvalidType`.
#[derive(Deserialize, Default, PartialEq)]
#[shopify_function(rename_all = "camelCase")]
pub struct Configuration {
    #[shopify_function(default)]
    components: Vec<Component>,
}

/// One product variant inside the bundle.
#[derive(Deserialize, Default, PartialEq)]
#[shopify_function(rename_all = "camelCase")]
pub struct Component {
    /// Variant GID of the component.
    #[shopify_function(default)]
    id: String,
    /// How many of this variant one bundle unit contains.
    #[shopify_function(default)]
    quantity: i32,
    /// Optional per-unit price, expressed in the **shop's** currency.
    /// Omit it to fall back to the bundle product's own price.
    #[shopify_function(default)]
    price: String,
}

#[shopify_function]
fn cart_transform_run(
    input: schema::cart_transform_run::Input,
) -> Result<schema::CartTransformRunResult> {
    // Config prices are written in the shop's currency, so they need converting
    // into whatever currency the buyer is seeing.
    let presentment_currency_rate = input.presentment_currency_rate().as_f64();

    let mut operations: Vec<schema::Operation> = Vec::new();

    for line in input.cart().lines().iter() {
        let variant = match line.merchandise() {
            schema::cart_transform_run::input::cart::lines::Merchandise::ProductVariant(variant) => {
                variant
            }
            // Custom products are never bundles.
            _ => continue,
        };

        // Only lines whose product carries a bundle definition are expanded; every
        // other line is left completely alone.
        let configuration: &Configuration = match variant.product().bundle_components() {
            Some(metafield) => metafield.json_value(),
            None => continue,
        };

        let expanded_cart_items = build_expanded_items(
            configuration,
            variant.id(),
            presentment_currency_rate,
        );

        if expanded_cart_items.is_empty() {
            continue;
        }

        operations.push(expand_operation(line.id(), expanded_cart_items));
    }

    if operations.is_empty() {
        return Ok(no_changes());
    }

    Ok(schema::CartTransformRunResult { operations })
}

/// Turns the configured components into expanded cart items.
///
/// Shopify rejects an expansion that mixes priced and unpriced items, so pricing is
/// all-or-nothing: when *every* component declares a price they are all priced
/// (converted to presentment currency); otherwise none are, and Shopify falls back
/// to the bundle product's own price.
fn build_expanded_items(
    configuration: &Configuration,
    bundle_variant_id: &str,
    presentment_currency_rate: f64,
) -> Vec<schema::ExpandedItem> {
    // Ignore components that could never resolve to a real variant or quantity.
    let components: Vec<&Component> = configuration
        .components
        .iter()
        .filter(|component| !component.id.is_empty() && component.quantity > 0)
        .collect();

    if components.is_empty() {
        return vec![];
    }

    // A lone component that points back at the bundle's own variant would expand
    // into itself forever, so leave that line untouched.
    if components.len() == 1 && components[0].id == bundle_variant_id {
        return vec![];
    }

    let price_every_component = components
        .iter()
        .all(|component| parse_price(&component.price).is_some());

    components
        .iter()
        .map(|component| schema::ExpandedItem {
            merchandise_id: component.id.clone(),
            quantity: component.quantity,
            price: if price_every_component {
                let amount = parse_price(&component.price).unwrap_or(0.0) * presentment_currency_rate;
                Some(fixed_price(Decimal::from(amount)))
            } else {
                None
            },
            attributes: None,
        })
        .collect()
}

fn parse_price(price: &str) -> Option<f64> {
    price.trim().parse::<f64>().ok()
}

fn fixed_price(amount: Decimal) -> schema::ExpandedItemPriceAdjustment {
    schema::ExpandedItemPriceAdjustment {
        adjustment: schema::ExpandedItemPriceAdjustmentValue::FixedPricePerUnit(
            schema::ExpandedItemFixedPricePerUnitAdjustment { amount },
        ),
    }
}

fn expand_operation(
    cart_line_id: &str,
    expanded_cart_items: Vec<schema::ExpandedItem>,
) -> schema::Operation {
    schema::Operation::LineExpand(schema::LineExpandOperation {
        cart_line_id: cart_line_id.to_string(),
        expanded_cart_items,
        image: None,
        price: None,
        title: None,
    })
}

fn no_changes() -> schema::CartTransformRunResult {
    schema::CartTransformRunResult { operations: vec![] }
}

#[cfg(test)]
mod tests {
    use super::*;
    use shopify_function::{run_function_with_input, Result};

    const BUNDLE_VARIANT: &str = "gid://shopify/ProductVariant/999";
    const COMPONENT_A: &str = "gid://shopify/ProductVariant/111";
    const COMPONENT_B: &str = "gid://shopify/ProductVariant/222";

    /// Builds an input payload for one cart line, optionally carrying a bundle
    /// definition on its product.
    fn bundle_input(quantity: i32, components_json: Option<&str>, rate: &str) -> String {
        let metafield = match components_json {
            Some(json) => format!(r#"{{ "jsonValue": {json} }}"#),
            None => "null".to_string(),
        };

        format!(
            r#"{{
                "presentmentCurrencyRate": "{rate}",
                "cart": {{
                    "lines": [
                        {{
                            "id": "gid://shopify/CartLine/1",
                            "quantity": {quantity},
                            "merchandise": {{
                                "__typename": "ProductVariant",
                                "id": "{BUNDLE_VARIANT}",
                                "product": {{
                                    "id": "gid://shopify/Product/1",
                                    "bundleComponents": {metafield}
                                }}
                            }}
                        }}
                    ]
                }}
            }}"#
        )
    }

    /// Asserts the result is exactly one line-expand operation and returns it.
    fn expect_single_expand(
        result: &schema::CartTransformRunResult,
    ) -> (&str, &Vec<schema::ExpandedItem>) {
        assert_eq!(result.operations.len(), 1, "expected exactly one operation");
        match &result.operations[0] {
            schema::Operation::LineExpand(expand) => {
                (expand.cart_line_id.as_str(), &expand.expanded_cart_items)
            }
            _ => panic!("expected a lineExpand operation"),
        }
    }

    /// Reads the fixed per-unit price off an expanded item, if it has one.
    fn fixed_price_of(item: &schema::ExpandedItem) -> Option<f64> {
        match &item.price {
            Some(adjustment) => match &adjustment.adjustment {
                schema::ExpandedItemPriceAdjustmentValue::FixedPricePerUnit(fixed) => {
                    Some(fixed.amount.as_f64())
                }
            },
            None => None,
        }
    }

    #[test]
    fn a_product_without_a_bundle_definition_is_left_alone() -> Result<()> {
        let result = run_function_with_input(
            cart_transform_run,
            &bundle_input(2, None, "1.0"),
        )?;

        assert_eq!(result.operations, vec![]);
        Ok(())
    }

    #[test]
    fn an_empty_component_list_produces_no_operations() -> Result<()> {
        let result = run_function_with_input(
            cart_transform_run,
            &bundle_input(2, Some(r#"{ "components": [] }"#), "1.0"),
        )?;

        assert_eq!(result.operations, vec![]);
        Ok(())
    }

    #[test]
    fn expands_a_bundle_into_its_components() -> Result<()> {
        let result = run_function_with_input(
            cart_transform_run,
            &bundle_input(
                1,
                Some(r#"{ "components": [
                    { "id": "gid://shopify/ProductVariant/111", "quantity": 2, "price": "24.99" },
                    { "id": "gid://shopify/ProductVariant/222", "quantity": 1, "price": "9.95" }
                ] }"#),
                "1.0",
            ),
        )?;

        let (cart_line_id, items) = expect_single_expand(&result);
        assert_eq!(cart_line_id, "gid://shopify/CartLine/1");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].merchandise_id.as_str(), COMPONENT_A);
        assert_eq!(items[0].quantity, 2);
        assert_eq!(fixed_price_of(&items[0]), Some(24.99));
        assert_eq!(items[1].merchandise_id.as_str(), COMPONENT_B);
        assert_eq!(items[1].quantity, 1);
        assert_eq!(fixed_price_of(&items[1]), Some(9.95));
        Ok(())
    }

    #[test]
    fn converts_component_prices_to_presentment_currency() -> Result<()> {
        let result = run_function_with_input(
            cart_transform_run,
            &bundle_input(
                1,
                Some(r#"{ "components": [
                    { "id": "gid://shopify/ProductVariant/111", "quantity": 1, "price": "10.00" }
                ] }"#),
                "1.5",
            ),
        )?;

        let (_, items) = expect_single_expand(&result);
        assert_eq!(fixed_price_of(&items[0]), Some(15.0));
        Ok(())
    }

    #[test]
    fn unpriced_components_leave_every_price_unset() -> Result<()> {
        // Mixing priced and unpriced items is an invalid expansion, so a component
        // without a price means none of them are priced.
        let result = run_function_with_input(
            cart_transform_run,
            &bundle_input(
                1,
                Some(r#"{ "components": [
                    { "id": "gid://shopify/ProductVariant/111", "quantity": 1, "price": "10.00" },
                    { "id": "gid://shopify/ProductVariant/222", "quantity": 1 }
                ] }"#),
                "1.0",
            ),
        )?;

        let (_, items) = expect_single_expand(&result);
        assert_eq!(items.len(), 2);
        assert!(items.iter().all(|item| item.price.is_none()));
        Ok(())
    }

    #[test]
    fn ignores_a_bundle_that_would_expand_into_itself() -> Result<()> {
        let result = run_function_with_input(
            cart_transform_run,
            &bundle_input(
                1,
                Some(r#"{ "components": [
                    { "id": "gid://shopify/ProductVariant/999", "quantity": 1, "price": "10.00" }
                ] }"#),
                "1.0",
            ),
        )?;

        assert_eq!(result.operations, vec![]);
        Ok(())
    }

    #[test]
    fn component_quantities_are_per_bundle_unit_not_multiplied_by_us() -> Result<()> {
        // A line of 3 bundles still yields the per-unit recipe (2 and 1); Shopify is
        // what multiplies by the line quantity.
        let result = run_function_with_input(
            cart_transform_run,
            &bundle_input(
                3,
                Some(r#"{ "components": [
                    { "id": "gid://shopify/ProductVariant/111", "quantity": 2, "price": "10.00" },
                    { "id": "gid://shopify/ProductVariant/222", "quantity": 1, "price": "5.00" }
                ] }"#),
                "1.0",
            ),
        )?;

        let (_, items) = expect_single_expand(&result);
        assert_eq!(items[0].quantity, 2);
        assert_eq!(items[1].quantity, 1);
        Ok(())
    }
}
