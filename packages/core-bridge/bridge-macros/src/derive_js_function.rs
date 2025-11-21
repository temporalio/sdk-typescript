use quote::format_ident;
use quote::quote;
use syn::GenericArgument;
use syn::Pat;
use syn::PathArguments;
use syn::Type;
use syn::{FnArg, ItemFn, PatType, ReturnType, parse_macro_input};

pub fn js_function_impl(
    _attr: proc_macro::TokenStream,
    item: proc_macro::TokenStream,
) -> proc_macro::TokenStream {
    let input = parse_macro_input!(item as ItemFn);

    let vis = &input.vis;
    let fn_name = &input.sig.ident;
    let generics = &input.sig.generics; // Is this still pertinent?
    let args = &input.sig.inputs;
    let return_type = &input.sig.output; // Can we avoid in some cases?
    let fn_block = &input.block;
    let attrs = &input.attrs;

    let fn_impl_name = format_ident!("{}_impl", fn_name);

    // Extract function arguments
    let args = args
        .iter()
        .filter_map(|arg| {
            if let FnArg::Typed(PatType { pat, ty, .. }) = arg {
                if let Pat::Ident(pat_ident) = &**pat {
                    Some((pat_ident.ident.clone(), (*ty).clone()))
                } else {
                    None
                }
            } else {
                None
            }
        })
        .collect::<Vec<_>>();

    // Extract return type
    let (result_return_type, inner_return_type) = match return_type {
        ReturnType::Type(_, ty) => match extract_bridge_result_type(ty) {
            Some(inner_type) => (ty, inner_type),
            None => panic!("Return type must be a BridgeResult"),
        },
        ReturnType::Default => panic!("Return type must be a BridgeResult"),
    };

    // Generate argument conversions
    let arg_conversions = args.iter().enumerate().map(|(i, (name, ty))| {
        quote! {
            use crate::helpers::*;
            let #name = cx.argument_into::<#ty>(#i).field(format!("fn {}", stringify!(#fn_name)).as_str()).into_throw(&mut cx)?;
        }
    });

    // Generate implementation function arguments
    let impl_args = args.iter().map(|(name, ty)| {
        quote! { #name: #ty }
    });

    // Generate argument names for impl function call
    let arg_names = args.iter().map(|(name, _)| quote! { #name });

    let expanded = if args.is_empty() {
        // No arguments case
        quote! {
            // Bridge function
            #[allow(clippy::significant_drop_tightening, clippy::unnecessary_wraps)]
            #vis fn #fn_name #generics(
                mut cx: FunctionContext #generics
            ) -> JsResult<<#inner_return_type as crate::helpers::TryIntoJs>::Output> {
                let result = #fn_impl_name().into_throw(&mut cx)?;
                result.try_into_js(&mut cx)
            }

            // Implementation function
            #(#attrs)*
            #[allow(clippy::unnecessary_wraps)]
            #vis fn #fn_impl_name #generics() -> #result_return_type {
                #fn_block
            }
        }
    } else {
        // With arguments case
        quote! {
            // Bridge function
            #[allow(clippy::significant_drop_tightening, clippy::unnecessary_wraps)]
            #vis fn #fn_name #generics(
                mut cx: FunctionContext #generics
            ) -> JsResult<<#inner_return_type as crate::helpers::TryIntoJs>::Output> {
                #(#arg_conversions)*

                let result = #fn_impl_name(#(#arg_names),*).into_throw(&mut cx)?;
                result.try_into_js(&mut cx)
            }

            // Implementation function
            #(#attrs)*
            #[allow(clippy::unnecessary_wraps)]
            #vis fn #fn_impl_name #generics(#(#impl_args),*) -> #result_return_type {
                #fn_block
            }
        }
    };

    proc_macro::TokenStream::from(expanded)
}

fn extract_bridge_result_type(ty: &Type) -> Option<&Type> {
    if let Type::Path(type_path) = ty {
        if let Some(last_segment) = type_path.path.segments.last() {
            // Check if it's BridgeResult
            if last_segment.ident == "BridgeResult" {
                // Extract the type parameter T from BridgeResult<T>
                if let PathArguments::AngleBracketed(generic_args) = &last_segment.arguments {
                    if let Some(GenericArgument::Type(inner_type)) = generic_args.args.first() {
                        return Some(inner_type);
                    }
                }
            }
        }
    }
    None
}
