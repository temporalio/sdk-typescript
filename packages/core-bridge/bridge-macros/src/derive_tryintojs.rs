use convert_case::{Case, Casing};
use proc_macro2::TokenStream;
use quote::quote;
use syn::{DeriveInput, FieldsNamed};

pub fn derive_tryintojs_struct(input: &DeriveInput, data: &syn::DataStruct) -> TokenStream {
    let struct_ident = &input.ident;
    let generics = &input.generics;
    let (impl_generics, ty_generics, where_clause) = generics.split_for_impl();

    let field_conversions = if let syn::Fields::Named(ref fields) = data.fields {
        field_conversions_for_named_fields(fields)
    } else {
        panic!("Only named fields are supported")
    };

    let expanded = quote! {
        impl #impl_generics crate::helpers::TryIntoJs for #struct_ident #ty_generics #where_clause {
            type Output = neon::types::JsObject;

            fn try_into_js<'a>(self, cx: &mut impl neon::prelude::Context<'a>) -> neon::result::JsResult<'a, Self::Output> {
                let obj = cx.empty_object();
                #(#field_conversions)*
                Ok(obj)
            }
        }
    };

    TokenStream::from(expanded)
}

pub fn derive_tryintojs_enum(input: &DeriveInput, data: &syn::DataEnum) -> TokenStream {
    let enum_ident = &input.ident;
    let generics = &input.generics;
    let (impl_generics, ty_generics, where_clause) = generics.split_for_impl();

    let variant_conversions = data.variants.iter().map(|v| {
        let variant_ident = &v.ident;
        let js_discriminant = variant_ident.to_string().to_case(Case::Camel);

        match &v.fields {
            syn::Fields::Unit => {
                quote! {
                    #enum_ident::#variant_ident => {
                        let obj = cx.empty_object();
                        let type_str = cx.string(#js_discriminant);
                        obj.set(cx, "type", type_str)?;
                        obj
                    }
                }
            }
            syn::Fields::Unnamed(fields) => {
                if fields.unnamed.len() != 1 {
                    panic!("Enum variants with unnamed fields must have exactly one field");
                }

                quote! {
                    #enum_ident::#variant_ident(inner) => {
                        let obj = cx.empty_object();
                        let type_str = cx.string(#js_discriminant);
                        obj.set(cx, "type", type_str)?;

                        let inner_js = inner.try_into_js(cx)?;
                        if inner_js.is_a::<neon::types::JsObject, _>(cx) {
                            // If inner is a JsObject, copy its properties to our object
                            let inner_obj = inner_js.downcast::<neon::types::JsObject, _>(cx).unwrap();
                            let prop_names = inner_obj.get_own_property_names(cx)?.to_vec(cx)?;

                            for key_handle in prop_names {
                                let value = inner_obj.get_value(cx, key_handle)?;
                                obj.set(cx, key_handle, value)?;
                            }
                        }

                        obj
                    }
                }
            }
            syn::Fields::Named(fields) => {
                let field_names = fields.named.iter().map(|f| {
                    let field_ident = &f.ident;
                    let js_name = field_ident.as_ref().unwrap().to_string().to_case(Case::Camel);
                    (field_ident, js_name)
                });

                let pattern_fields = field_names.clone().map(|(field_ident, _)| {
                    quote! { #field_ident }
                });

                let field_sets = field_names.map(|(field_ident, js_name)| {
                    quote! {
                        let js_value = #field_ident.try_into_js(cx)?;
                        obj.set(cx, #js_name, js_value)?;
                    }
                });

                quote! {
                    #enum_ident::#variant_ident { #(#pattern_fields),* } => {
                        let obj = cx.empty_object();
                        let type_str = cx.string(#js_discriminant);
                        obj.set(cx, "type", type_str)?;

                        #(#field_sets)*

                        obj
                    }
                }
            }
        }
    });

    let expanded = quote! {
        impl #impl_generics crate::helpers::TryIntoJs for #enum_ident #ty_generics #where_clause {
            type Output = neon::types::JsObject;

            fn try_into_js<'a>(self, cx: &mut impl neon::prelude::Context<'a>) -> neon::result::JsResult<'a, Self::Output> {
                Ok(match self {
                    #(#variant_conversions),*
                })
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

        // Ignore PhantomData fields
        if let syn::Type::Path(path) = &f.ty {
            if let Some(segment) = path.path.segments.last() {
                if segment.ident == "PhantomData" {
                    return quote! {};
                }
            }
        }

        quote! {
            let js_value = self.#field_ident.try_into_js(cx)?;
            obj.set(cx, #js_name, js_value)?;
        }
    })
}
