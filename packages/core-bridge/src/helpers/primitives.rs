use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use neon::{
    handle::Handle,
    object::Object,
    prelude::Context,
    result::JsResult,
    types::{
        JsArray, JsBigInt, JsBoolean, JsBuffer, JsNull, JsNumber, JsObject, JsString, JsUndefined,
        JsValue, Value, buffer::TypedArray,
    },
};
use temporal_sdk_core::Url;

use super::{BridgeError, BridgeResult, conversions::log_js_object};

// TryIntoJs implementations for primitives and other basic types //////////////////////////////////

/// Trait for Rust types that can be created from JavaScript values, possibly throwing an error.
pub trait TryFromJs: Sized {
    fn try_from_js<'cx, 'b>(
        cx: &mut impl Context<'cx>,
        js_value: Handle<'b, JsValue>,
    ) -> BridgeResult<Self>;
}

impl TryFromJs for () {
    fn try_from_js<'cx, 'b>(
        _cx: &mut impl Context<'cx>,
        _: Handle<'b, JsValue>,
    ) -> BridgeResult<Self> {
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
        Ok(js_value.downcast::<JsNumber, _>(cx)?.value(cx) as u16)
    }
}

impl TryFromJs for i32 {
    fn try_from_js<'cx, 'b>(
        cx: &mut impl Context<'cx>,
        js_value: Handle<'b, JsValue>,
    ) -> BridgeResult<Self> {
        Ok(js_value.downcast::<JsNumber, _>(cx)?.value(cx) as i32)
    }
}

impl TryFromJs for f32 {
    fn try_from_js<'cx, 'b>(
        cx: &mut impl Context<'cx>,
        js_value: Handle<'b, JsValue>,
    ) -> BridgeResult<Self> {
        Ok(js_value.downcast::<JsNumber, _>(cx)?.value(cx) as f32)
    }
}

impl TryFromJs for u64 {
    fn try_from_js<'cx, 'b>(
        cx: &mut impl Context<'cx>,
        js_value: Handle<'b, JsValue>,
    ) -> BridgeResult<Self> {
        Ok(js_value.downcast::<JsNumber, _>(cx)?.value(cx) as u64)
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

impl TryFromJs for u128 {
    fn try_from_js<'cx, 'b>(
        cx: &mut impl Context<'cx>,
        js_value: Handle<'b, JsValue>,
    ) -> BridgeResult<Self> {
        Ok(js_value.downcast::<JsNumber, _>(cx)?.value(cx) as u128)
    }
}

impl TryFromJs for usize {
    fn try_from_js<'cx, 'b>(
        cx: &mut impl Context<'cx>,
        js_value: Handle<'b, JsValue>,
    ) -> BridgeResult<Self> {
        Ok(js_value.downcast::<JsNumber, _>(cx)?.value(cx) as usize)
    }
}

impl TryFromJs for Duration {
    fn try_from_js<'cx, 'b>(
        cx: &mut impl Context<'cx>,
        js_value: Handle<'b, JsValue>,
    ) -> BridgeResult<Self> {
        Ok(Duration::from_millis(
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
        Ok(js_value
            .downcast::<JsBuffer, _>(cx)
            .inspect_err(|_e| {
                log_js_object(cx, &js_value);
            })?
            .as_slice(cx)
            .to_vec())
    }
}

impl<T: TryFromJs> TryFromJs for Vec<T> {
    fn try_from_js<'cx, 'b>(
        cx: &mut impl Context<'cx>,
        js_value: Handle<'b, JsValue>,
    ) -> BridgeResult<Self> {
        let array = js_value.downcast::<JsArray, _>(cx)?;
        let len = array.len(cx);
        let mut result = Vec::with_capacity(len as usize);

        for i in 0..len {
            let value = array.get_value(cx, i)?;
            result.push(T::try_from_js(cx, value)?);
        }
        Ok(result)
    }
}

impl<T: TryFromJs> TryFromJs for HashMap<String, T> {
    fn try_from_js<'cx, 'b>(
        cx: &mut impl Context<'cx>,
        js_value: Handle<'b, JsValue>,
    ) -> BridgeResult<Self> {
        let obj = js_value.downcast::<JsObject, _>(cx)?;
        let props = obj.get_own_property_names(cx)?.to_vec(cx)?;

        let mut map = HashMap::new();
        for key_handle in props {
            let key = key_handle.to_string(cx)?.value(cx);
            // FIXME: Previous code was using `key.as_str()` here, but that seems innefficient.
            //        Remove comment once confirmed this works.
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
        let addr = addr.to_string(cx)?;
        addr.value(cx)
            .parse::<SocketAddr>()
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
        let url = url.to_string(cx)?;
        url.value(cx)
            .parse::<Url>()
            .map_err(|e| BridgeError::TypeError {
                field: None,
                message: e.to_string(),
            })
    }
}

// TryIntoJs implementations for primitives and other basic types //////////////////////////////////

/// Trait for types that can be converted to JavaScript values, possibly throwing an error.
pub trait TryIntoJs {
    type Output: Value;
    fn try_into_js<'cx>(self, cx: &mut impl Context<'cx>) -> JsResult<'cx, Self::Output>;
}

impl TryIntoJs for () {
    type Output = JsUndefined;
    fn try_into_js<'a>(self, cx: &mut impl Context<'a>) -> JsResult<'a, JsUndefined> {
        Ok(cx.undefined())
    }
}

impl TryIntoJs for bool {
    type Output = JsBoolean;
    fn try_into_js<'a>(self, cx: &mut impl Context<'a>) -> JsResult<'a, JsBoolean> {
        Ok(cx.boolean(self))
    }
}

impl TryIntoJs for String {
    type Output = JsString;
    fn try_into_js<'a>(self, cx: &mut impl Context<'a>) -> JsResult<'a, JsString> {
        Ok(cx.string(self.as_str()))
    }
}

impl<T: TryIntoJs> TryIntoJs for Vec<T> {
    type Output = JsArray;

    fn try_into_js<'a>(self, cx: &mut impl Context<'a>) -> JsResult<'a, JsArray> {
        let array = cx.empty_array();
        for (i, item) in self.into_iter().enumerate() {
            let item = item.try_into_js(cx)?;
            array.set(cx, i as u32, item)?;
        }
        Ok(array)
    }
}

impl TryIntoJs for Vec<u8> {
    type Output = JsBuffer;
    fn try_into_js<'a>(self, cx: &mut impl Context<'a>) -> JsResult<'a, JsBuffer> {
        JsBuffer::from_slice(cx, &self)
    }
}

impl TryIntoJs for SystemTime {
    type Output = JsBigInt;
    fn try_into_js<'a>(self, cx: &mut impl Context<'a>) -> JsResult<'a, JsBigInt> {
        let nanos = self
            .duration_since(UNIX_EPOCH)
            .unwrap_or(Duration::ZERO)
            .as_nanos();
        Ok(JsBigInt::from_u128(cx, nanos))
    }
}

impl<T: TryIntoJs> TryIntoJs for Option<T> {
    // Output really is (T::Output | JsNull), hence JsValue
    type Output = JsValue;
    fn try_into_js<'a>(self, cx: &mut impl Context<'a>) -> JsResult<'a, JsValue> {
        if let Some(value) = self {
            Ok(value.try_into_js(cx)?.upcast())
        } else {
            Ok(cx.null().upcast())
        }
    }
}

impl<T: TryIntoJs + Clone> TryIntoJs for Arc<T> {
    type Output = T::Output;
    fn try_into_js<'a>(self, cx: &mut impl Context<'a>) -> JsResult<'a, T::Output> {
        self.as_ref().clone().try_into_js(cx)
    }
}
