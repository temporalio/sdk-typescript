mod derive_js_function;
mod derive_tryfromjs;
mod derive_tryintojs;

use derive_js_function::js_function_impl;
use derive_tryfromjs::{derive_tryfromjs_enum, derive_tryfromjs_struct};
use derive_tryintojs::{derive_tryintojs_enum, derive_tryintojs_struct};
use proc_macro::TokenStream;
use syn::{DeriveInput, parse_macro_input};

/// Procedural macro for defining bridge types with compile-time field name conversion
///
/// Note that enum types must all be defined on the JS side as objects with a `type` field which
/// is the kebab-case representation of the enum variant.
#[proc_macro_derive(TryFromJs)]
pub fn try_from_js(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);

    match &input.data {
        syn::Data::Struct(data) => derive_tryfromjs_struct(&input, data).into(),
        syn::Data::Enum(data) => derive_tryfromjs_enum(&input, data).into(),
        syn::Data::Union(_) => panic!("Unions are not supported"),
    }
}

/// Procedural macro for defining bridge types with compile-time field name conversion
#[proc_macro_derive(TryIntoJs)]
pub fn try_into_js(input: TokenStream) -> TokenStream {
    let input = parse_macro_input!(input as DeriveInput);

    match &input.data {
        syn::Data::Struct(data) => derive_tryintojs_struct(&input, data).into(),
        syn::Data::Enum(data) => derive_tryintojs_enum(&input, data).into(),
        syn::Data::Union(_) => panic!("Unions are not supported"),
    }
}

/// Generates a function that can be called from JavaScript with the given name
#[proc_macro_attribute]
pub fn js_function(attr: TokenStream, input: TokenStream) -> TokenStream {
    js_function_impl(attr, input)
}
