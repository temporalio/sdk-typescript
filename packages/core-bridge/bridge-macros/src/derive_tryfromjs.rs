use convert_case::{Case, Casing};
use proc_macro2::TokenStream;
use quote::quote;
use syn::{DeriveInput, FieldsNamed, FieldsUnnamed};

pub fn derive_tryfromjs_struct(input: &DeriveInput, data: &syn::DataStruct) -> TokenStream {
    let struct_ident = &input.ident;
    let generics = &input.generics;
    let (impl_generics, ty_generics, where_clause) = generics.split_for_impl();

    let field_conversions = if let syn::Fields::Named(ref fields) = data.fields {
        field_conversions_for_named_fields(fields)
    } else {
        panic!("Only named fields are supported")
    };

    let expanded = quote! {
        impl #impl_generics crate::helpers::TryFromJs for #struct_ident #ty_generics #where_clause {
            fn try_from_js<'cx, 'b>(cx: &mut impl neon::prelude::Context<'cx>, js_value: neon::prelude::Handle<'b, neon::prelude::JsValue>) -> crate::helpers::BridgeResult<Self> {
                use crate::helpers::*;

                let obj = js_value.downcast::<neon::prelude::JsObject, _>(cx)?;
                Ok(Self {
                    #(#field_conversions),*
                })
            }
        }
    };

    TokenStream::from(expanded)
}

pub fn derive_tryfromjs_enum(input: &DeriveInput, data: &syn::DataEnum) -> TokenStream {
    let enum_ident = &input.ident;
    let enum_name = enum_ident.to_string();
    let variants = &data.variants;
    let generics = &input.generics;
    let (impl_generics, ty_generics, where_clause) = generics.split_for_impl();

    let variant_conversions = variants.iter().map(|v| {
        let variant_ident = &v.ident;
        let discriminant = variant_ident.to_string().to_case(Case::Kebab);
        let js_discriminant = variant_ident.to_string().to_case(Case::Camel);

        match &v.fields {
            syn::Fields::Unit => {
                // e.g. "otel" => Ok(MetricsExporter::Otel)
                quote! {
                    #discriminant => Ok(#enum_ident::#variant_ident),
                }
            }
            syn::Fields::Unnamed(FieldsUnnamed { unnamed, .. }) => {
                if unnamed.len() != 1 {
                    panic!("Enum variant must have a single unnamed field that implements the TryFromJs trait");
                }
                let ty = unnamed.first().map(|f| f.ty.clone()).unwrap();
                match ty {
                    syn::Type::Path(path) => {
                        // Example output:
                        //
                        // "otel" => {
                        //    <OtelConfig>::try_from_js(cx, js_value).field("otel").map(MetricsExporter::Otel)
                        // }
                        quote! {
                            #discriminant => {
                                <#path>::try_from_js(cx, js_value).field(&#js_discriminant).map(#enum_ident::#variant_ident)
                            },
                        }
                    },
                    _ => panic!("Enum variant must have a single unnamed field that implements the TryFromJs trait"),
                }
            }
            syn::Fields::Named(fields) => {
                // Example output:
                //
                //   "console" => Ok((|| {
                //       Ok::<LogExporter, BridgeError>(LogExporter::Console {
                //           filter: { obj.get_property_into(cx, "filter")? },
                //       })
                //   })()
                //   .field(format!("type={}", type_str).as_str())?),
                //
                // The inner closure is required so that we can use the `field` method on the result.
                // An alternative would be to do that at the field level, but then that concern would
                // spill into the field_conversions_for_named_fields function, which is used in
                // other places.
                let field_conversions = field_conversions_for_named_fields(fields);
                quote! {
                    #discriminant => Ok(( || {
                        Ok::<#enum_ident #ty_generics, crate::helpers::BridgeError>(#enum_ident::#variant_ident {
                            #(#field_conversions),*
                        })
                    })()
                    .field(&#js_discriminant)?),
                }
            }
        }
    });

    let expanded = quote! {
        impl #impl_generics crate::helpers::TryFromJs for #enum_ident #ty_generics #where_clause {
            fn try_from_js<'cx, 'b>(cx: &mut impl neon::prelude::Context<'cx>, js_value: neon::prelude::Handle<'b, neon::prelude::JsValue>) -> crate::helpers::BridgeResult<Self> {
                use crate::helpers::*;

                let obj = js_value.downcast::<neon::prelude::JsObject, _>(cx)?;
                let type_str: String = obj.get_property_into(cx, "type")?;

                match type_str.as_str() {
                    #(#variant_conversions)*
                    _ => Err(crate::helpers::BridgeError::InvalidVariant {
                        enum_name: #enum_name.to_string(),
                        variant: type_str,
                    }),
                }
            }
        }
    };

    TokenStream::from(expanded)
}

fn field_conversions_for_named_fields(
    fields: &FieldsNamed,
) -> impl Iterator<Item = TokenStream> + '_ {
    fields.named.iter().map(|f| {
        let field_ident = f
            .ident
            .as_ref()
            .expect("FieldsNamed.named must have an identifier");
        let js_name = field_ident.to_string().to_case(Case::Camel);

        quote! {
            #field_ident: {
                obj.get_property_into(cx, #js_name)?
            }
        }
    })
}
