use std::{collections::HashMap, net::SocketAddr, time::Duration};

use neon::{
    handle::Handle,
    object::Object,
    prelude::Context,
    types::{
        JsArray, JsBoolean, JsBuffer, JsNull, JsNumber, JsObject, JsString, JsUndefined, JsValue,
        Value, buffer::TypedArray,
    },
};
use temporal_sdk_core::Url;

use super::{BridgeError, BridgeResult};

/// Trait for Rust types that can be created from JavaScript values, possibly throwing an error.
pub trait TryFromJs: Sized {
    fn try_from_js<'cx, 'b>(
        cx: &mut impl Context<'cx>,
        js_value: Handle<'b, JsValue>,
    ) -> BridgeResult<Self>;
}

// TryFromJs implementations for primitives and other basic types //////////////////////////////////

impl TryFromJs for () {
    fn try_from_js<'cx, 'b>(
        cx: &mut impl Context<'cx>,
        js_value: Handle<'b, JsValue>,
    ) -> BridgeResult<Self> {
        // Make sure we are not getting something where we expect nothing
        let _ = js_value.downcast::<JsUndefined, _>(cx)?;
        Ok(())
    }
}

impl TryFromJs for String {
    fn try_from_js<'cx, 'b>(
        cx: &mut impl Context<'cx>,
        js_value: Handle<'b, JsValue>,
    ) -> BridgeResult<Self> {
        Ok(js_value.downcast::<JsString, _>(cx)?.value(cx))
    }
}

impl TryFromJs for bool {
    fn try_from_js<'cx, 'b>(
        cx: &mut impl Context<'cx>,
        js_value: Handle<'b, JsValue>,
    ) -> BridgeResult<Self> {
        Ok(js_value.downcast::<JsBoolean, _>(cx)?.value(cx))
    }
}

impl TryFromJs for u16 {
    fn try_from_js<'cx, 'b>(
        cx: &mut impl Context<'cx>,
        js_value: Handle<'b, JsValue>,
    ) -> BridgeResult<Self> {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        Ok(js_value.downcast::<JsNumber, _>(cx)?.value(cx) as Self)
    }
}

#[allow(clippy::cast_possible_truncation)]
impl TryFromJs for i32 {
    fn try_from_js<'cx, 'b>(
        cx: &mut impl Context<'cx>,
        js_value: Handle<'b, JsValue>,
    ) -> BridgeResult<Self> {
        Ok(js_value.downcast::<JsNumber, _>(cx)?.value(cx) as Self)
    }
}

#[allow(clippy::cast_possible_truncation)]
impl TryFromJs for f32 {
    fn try_from_js<'cx, 'b>(
        cx: &mut impl Context<'cx>,
        js_value: Handle<'b, JsValue>,
    ) -> BridgeResult<Self> {
        Ok(js_value.downcast::<JsNumber, _>(cx)?.value(cx) as Self)
    }
}

#[allow(clippy::cast_possible_truncation)]
impl TryFromJs for u64 {
    fn try_from_js<'cx, 'b>(
        cx: &mut impl Context<'cx>,
        js_value: Handle<'b, JsValue>,
    ) -> BridgeResult<Self> {
        #[allow(clippy::cast_sign_loss)]
        Ok(js_value.downcast::<JsNumber, _>(cx)?.value(cx) as Self)
    }
}

impl TryFromJs for f64 {
    fn try_from_js<'cx, 'b>(
        cx: &mut impl Context<'cx>,
        js_value: Handle<'b, JsValue>,
    ) -> BridgeResult<Self> {
        Ok(js_value.downcast::<JsNumber, _>(cx)?.value(cx))
    }
}

impl TryFromJs for usize {
    fn try_from_js<'cx, 'b>(
        cx: &mut impl Context<'cx>,
        js_value: Handle<'b, JsValue>,
    ) -> BridgeResult<Self> {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        Ok(js_value.downcast::<JsNumber, _>(cx)?.value(cx) as Self)
    }
}

impl TryFromJs for Duration {
    fn try_from_js<'cx, 'b>(
        cx: &mut impl Context<'cx>,
        js_value: Handle<'b, JsValue>,
    ) -> BridgeResult<Self> {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        Ok(Self::from_millis(
            js_value.downcast::<JsNumber, _>(cx)?.value(cx) as u64,
        ))
    }
}

impl<T: TryFromJs> TryFromJs for Option<T> {
    fn try_from_js<'cx, 'b>(
        cx: &mut impl Context<'cx>,
        js_value: Handle<'b, JsValue>,
    ) -> BridgeResult<Self> {
        if js_value.is_a::<JsNull, _>(cx) {
            Ok(None)
        } else {
            Ok(Some(T::try_from_js(cx, js_value)?))
        }
    }
}

impl TryFromJs for Vec<u8> {
    fn try_from_js<'cx, 'b>(
        cx: &mut impl Context<'cx>,
        js_value: Handle<'b, JsValue>,
    ) -> BridgeResult<Self> {
        Ok(js_value.downcast::<JsBuffer, _>(cx)?.as_slice(cx).to_vec())
    }
}

impl<T: TryFromJs> TryFromJs for Vec<T> {
    fn try_from_js<'cx, 'b>(
        cx: &mut impl Context<'cx>,
        js_value: Handle<'b, JsValue>,
    ) -> BridgeResult<Self> {
        let array = js_value.downcast::<JsArray, _>(cx)?;
        let len = array.len(cx);
        let mut result = Self::with_capacity(len as usize);

        for i in 0..len {
            let value = array.get_value(cx, i)?;
            result.push(T::try_from_js(cx, value)?);
        }
        Ok(result)
    }
}

#[allow(clippy::implicit_hasher)]
impl<T: TryFromJs> TryFromJs for HashMap<String, T> {
    fn try_from_js<'cx, 'b>(
        cx: &mut impl Context<'cx>,
        js_value: Handle<'b, JsValue>,
    ) -> BridgeResult<Self> {
        let obj = js_value.downcast::<JsObject, _>(cx)?;
        let props = obj.get_own_property_names(cx)?.to_vec(cx)?;

        let mut map = Self::new();
        for key_handle in props {
            let key = key_handle.to_string(cx)?.value(cx);
            let value = obj.get_value(cx, key_handle)?;
            map.insert(key, T::try_from_js(cx, value)?);
        }
        Ok(map)
    }
}

impl TryFromJs for SocketAddr {
    fn try_from_js<'cx, 'b>(
        cx: &mut impl Context<'cx>,
        js_value: Handle<'b, JsValue>,
    ) -> BridgeResult<Self> {
        let addr = js_value.downcast::<JsString, _>(cx)?;
        addr.value(cx)
            .parse::<Self>()
            .map_err(|e| BridgeError::TypeError {
                field: None,
                message: e.to_string(),
            })
    }
}

impl TryFromJs for Url {
    fn try_from_js<'cx, 'b>(
        cx: &mut impl Context<'cx>,
        js_value: Handle<'b, JsValue>,
    ) -> BridgeResult<Self> {
        let url = js_value.downcast::<JsString, _>(cx)?;
        url.value(cx)
            .parse::<Self>()
            .map_err(|e| BridgeError::TypeError {
                field: None,
                message: e.to_string(),
            })
    }
}
