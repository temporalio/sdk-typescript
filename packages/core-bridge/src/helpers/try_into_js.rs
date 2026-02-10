use std::{
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use neon::{
    object::Object,
    prelude::{Context, Root},
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

impl TryIntoJs for f64 {
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

/// A handle that wraps another `TryIntoJs` type, memoizing the converted JavaScript value.
/// That is, the value is converted to JavaScript only once, and then the same JavaScript value
/// is returned for subsequent calls. This notably ensures that the value sent to the JS side
/// is exactly the same object every time (i.e. `===` comparison is true).
#[derive(Clone, Debug)]
pub struct MemoizedHandle<T: TryIntoJs + Clone + std::fmt::Debug>
where
    T::Output: std::fmt::Debug,
{
    internal: Arc<Mutex<MemoizedInternal<T>>>,
}

#[derive(Debug)]
enum MemoizedInternal<T: TryIntoJs + Clone + std::fmt::Debug> {
    Pending(T),
    Rooted(Root<T::Output>),
}

impl<T: TryIntoJs + Clone + std::fmt::Debug> MemoizedHandle<T>
where
    T::Output: Object + std::fmt::Debug,
{
    pub fn new(value: T) -> Self {
        Self {
            internal: Arc::new(Mutex::new(MemoizedInternal::Pending(value))),
        }
    }
}

impl<T: TryIntoJs + Clone + std::fmt::Debug> TryIntoJs for MemoizedHandle<T>
where
    T::Output: Object + std::fmt::Debug,
{
    type Output = T::Output;
    fn try_into_js<'cx>(self, cx: &mut impl Context<'cx>) -> JsResult<'cx, T::Output> {
        let mut guard = self.internal.lock().expect("MemoizedHandle lock");
        match *guard {
            MemoizedInternal::Pending(ref value) => {
                let rooted_value = value.clone().try_into_js(cx)?.root(cx);
                let js_value = rooted_value.to_inner(cx);
                *guard = MemoizedInternal::Rooted(rooted_value);
                Ok(js_value)
            }
            MemoizedInternal::Rooted(ref handle) => Ok(handle.to_inner(cx)),
        }
    }
}

/// To avoid some recurring error patterns when crossing the JS bridge, we normally translate
/// `Option<T>` to `T | null` on the JS side. This however implies extra code on the JS side
/// to check for `null` and convert to `undefined` as appropriate. This generally poses no
/// problem, as manipulation of objects on the JS side is anyway desirable for other reasons.
///
/// In rare cases, however, this extra manipulation may not be desirable. For example, when
/// passing buffered metrics to the JS Side, we want to preserve object identity. Modifying
/// objects on the JS side would either break object identity or introduce unnecessary overhead.
///
/// For those rare cases, this newtype wrapper to indicate that an option property should be
/// translated to `undefined` on the JS side, rather than `null`.
#[derive(Clone, Debug)]
pub struct OptionAsUndefined<T: TryIntoJs + Clone + std::fmt::Debug>(Option<T>);

impl<T: TryIntoJs + Clone + std::fmt::Debug> From<Option<T>> for OptionAsUndefined<T> {
    fn from(value: Option<T>) -> Self {
        Self(value)
    }
}

impl<T: TryIntoJs + Clone + std::fmt::Debug> TryIntoJs for OptionAsUndefined<T> {
    type Output = JsValue;
    fn try_into_js<'a>(self, cx: &mut impl Context<'a>) -> JsResult<'a, JsValue> {
        if let Some(value) = self.0 {
            Ok(value.try_into_js(cx)?.upcast())
        } else {
            Ok(cx.undefined().upcast())
        }
    }
}
