use shopify_function::prelude::*;
use std::process;

pub mod cart_transform_run;

#[typegen("schema.graphql")]
pub mod schema {
    // `custom_scalar_overrides` maps the `jsonValue` JSON scalar to our typed
    // `Configuration` struct so the function never has to hand-parse JSON.
    // The path starts with the GraphQL **operation** name.
    #[query(
        "src/cart_transform_run.graphql",
        custom_scalar_overrides = {
            "Input.cart.lines.merchandise.product.bundleComponents.jsonValue" => super::cart_transform_run::Configuration
        }
    )]
    pub mod cart_transform_run {}
}

fn main() {
    log!("Please invoke a named export.");
    process::abort();
}
