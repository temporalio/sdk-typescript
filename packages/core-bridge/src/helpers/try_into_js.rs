use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use neon::{
    object::Object,
    prelude::Context,
    result::JsResult,
    types::{
        JsArray, JsBigInt, JsBoolean, JsBuffer, JsNumber, JsString, JsUndefined, JsValue, Value,
    },
};

////////////////////////////////////////////////////////////////////////////////////////////////////

/// Trait for types that can be converted to JavaScript values, possibly throwing an error.
pub trait TryIntoJs {
    type Output: Value;
    fn try_into_js<'cx>(self, cx: &mut impl Context<'cx>) -> JsResult<'cx, Self::Output>;
}

// TryIntoJs implementations for primitives and other basic types //////////////////////////////////

impl TryIntoJs for bool {
    type Output = JsBoolean;
    fn try_into_js<'a>(self, cx: &mut impl Context<'a>) -> JsResult<'a, JsBoolean> {
        Ok(cx.boolean(self))
    }
}

impl TryIntoJs for u32 {
    type Output = JsNumber;
    fn try_into_js<'a>(self, cx: &mut impl Context<'a>) -> JsResult<'a, JsNumber> {
        Ok(cx.number(self))
    }
}

impl TryIntoJs for String {
    type Output = JsString;
    fn try_into_js<'a>(self, cx: &mut impl Context<'a>) -> JsResult<'a, JsString> {
        Ok(cx.string(self.as_str()))
    }
}

impl TryIntoJs for &str {
    type Output = JsString;
    fn try_into_js<'a>(self, cx: &mut impl Context<'a>) -> JsResult<'a, JsString> {
        Ok(cx.string(self))
    }
}

impl<T: TryIntoJs> TryIntoJs for Vec<T> {
    type Output = JsArray;

    fn try_into_js<'a>(self, cx: &mut impl Context<'a>) -> JsResult<'a, JsArray> {
        let array = cx.empty_array();
        for (i, item) in self.into_iter().enumerate() {
            let item = item.try_into_js(cx)?;
            #[allow(clippy::cast_possible_truncation)]
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

impl TryIntoJs for &[u8] {
    type Output = JsBuffer;
    fn try_into_js<'a>(self, cx: &mut impl Context<'a>) -> JsResult<'a, JsBuffer> {
        JsBuffer::from_slice(cx, self)
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

impl TryIntoJs for () {
    type Output = JsUndefined;
    fn try_into_js<'a>(self, cx: &mut impl Context<'a>) -> JsResult<'a, JsUndefined> {
        Ok(cx.undefined())
    }
}

impl<T0: TryIntoJs, T1: TryIntoJs> TryIntoJs for (T0, T1) {
    type Output = JsArray;
    fn try_into_js<'a>(self, cx: &mut impl Context<'a>) -> JsResult<'a, JsArray> {
        let v0 = self.0.try_into_js(cx)?;
        let v1 = self.1.try_into_js(cx)?;

        let array = cx.empty_array();
        array.set(cx, 0, v0)?;
        array.set(cx, 1, v1)?;
        Ok(array)
    }
}
