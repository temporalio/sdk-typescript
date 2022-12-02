use crate::errors::*;
use neon::{prelude::*, types::buffer::TypedArray};
use std::{fmt::Display, future::Future, sync::Arc};

/// Send a result to JS via callback using a [Channel]
pub fn send_result<F, T>(channel: Arc<Channel>, callback: Root<JsFunction>, res_fn: F)
where
    F: for<'a> FnOnce(&mut TaskContext<'a>) -> NeonResult<Handle<'a, T>> + Send + 'static,
    T: Value,
{
    channel.send(move |mut cx| {
        let callback = callback.into_inner(&mut cx);
        let this = cx.undefined();
        let error = cx.undefined();
        let result = res_fn(&mut cx)?;
        let args: Vec<Handle<JsValue>> = vec![error.upcast(), result.upcast()];
        callback.call(&mut cx, this, args)?;
        Ok(())
    });
}

/// Send an error to JS via callback using a [Channel]
pub fn send_error<E, F>(channel: Arc<Channel>, callback: Root<JsFunction>, error_ctor: F)
where
    E: Object,
    F: for<'a> FnOnce(&mut TaskContext<'a>) -> JsResult<'a, E> + Send + 'static,
{
    channel.send(move |mut cx| {
        let callback = callback.into_inner(&mut cx);
        callback_with_error(&mut cx, callback, error_ctor)
    });
}

/// Call `callback` with given error
pub fn callback_with_error<'a, C, E, F>(
    cx: &mut C,
    callback: Handle<JsFunction>,
    error_ctor: F,
) -> NeonResult<()>
where
    C: Context<'a>,
    E: Object,
    F: FnOnce(&mut C) -> JsResult<'a, E> + Send + 'static,
{
    let this = cx.undefined();
    let error = error_ctor(cx)?;
    let result = cx.undefined();
    let args: Vec<Handle<JsValue>> = vec![error.upcast(), result.upcast()];
    callback.call(cx, this, args)?;
    Ok(())
}

/// Call `callback` with an UnexpectedError created from `err`
pub fn callback_with_unexpected_error<'a, C, E>(
    cx: &mut C,
    callback: Handle<JsFunction>,
    err: E,
) -> NeonResult<()>
where
    C: Context<'a>,
    E: Display,
{
    let err_str = format!("{}", err);
    callback_with_error(cx, callback, move |cx| {
        make_named_error_from_string(cx, UNEXPECTED_ERROR, err_str)
    })
}

/// When Future completes, call given JS callback using a neon::Channel with either error or
/// undefined
pub async fn void_future_to_js<E, F, ER, EF>(
    channel: Arc<Channel>,
    callback: Root<JsFunction>,
    f: F,
    error_function: EF,
) where
    E: Display + Send + 'static,
    F: Future<Output = Result<(), E>> + Send,
    ER: Object,
    EF: for<'a> FnOnce(&mut TaskContext<'a>, E) -> JsResult<'a, ER> + Send + 'static,
{
    match f.await {
        Ok(()) => {
            send_result(channel, callback, |cx| Ok(cx.undefined()));
        }
        Err(err) => {
            send_error(channel, callback, |cx| error_function(cx, err));
        }
    }
}

macro_rules! js_optional_getter {
    ($js_cx:expr, $js_obj:expr, $prop_name:expr, $js_type:ty) => {
        match get_optional($js_cx, $js_obj, $prop_name) {
            None => None,
            Some(val) => {
                if val.is_a::<$js_type, _>($js_cx) {
                    Some(val.downcast_or_throw::<$js_type, _>($js_cx)?)
                } else {
                    Some($js_cx.throw_type_error(format!("Invalid {}", $prop_name))?)
                }
            }
        }
    };
}

pub(crate) use js_optional_getter;

macro_rules! js_optional_value_getter {
    ($js_cx:expr, $js_obj:expr, $prop_name:expr, $js_type:ty) => {
        js_optional_getter!($js_cx, $js_obj, $prop_name, $js_type).map(|v| v.value($js_cx))
    };
}

pub(crate) use js_optional_value_getter;

macro_rules! js_value_getter {
    ($js_cx:expr, $js_obj:expr, $prop_name:expr, $js_type:ty) => {
        match js_optional_getter!($js_cx, $js_obj, $prop_name, $js_type) {
            Some(val) => val.value($js_cx),
            None => $js_cx.throw_type_error(format!("{} must be defined", $prop_name))?,
        }
    };
}

pub(crate) use js_value_getter;

/// Helper for extracting an optional attribute from [obj].
/// If [obj].[attr] is undefined or not present, None is returned
pub fn get_optional<'a, C, K>(
    cx: &mut C,
    obj: &Handle<JsObject>,
    attr: K,
) -> Option<Handle<'a, JsValue>>
where
    K: neon::object::PropertyKey,
    C: Context<'a>,
{
    match obj.get_value(cx, attr) {
        Err(_) => None,
        Ok(val) => match val.is_a::<JsUndefined, _>(cx) {
            true => None,
            false => Some(val),
        },
    }
}

/// Helper for extracting a Vec<u8> from optional Buffer at [obj].[attr]
pub fn get_optional_vec<'a, C, K>(
    cx: &mut C,
    obj: &Handle<JsObject>,
    attr: K,
) -> Result<Option<Vec<u8>>, neon::result::Throw>
where
    K: neon::object::PropertyKey + Display + Clone,
    C: Context<'a>,
{
    if let Some(val) = get_optional(cx, obj, attr.clone()) {
        let buf = val.downcast::<JsBuffer, C>(cx).map_err(|_| {
            cx.throw_type_error::<_, Option<Vec<u8>>>(format!("Invalid {}", attr))
                .unwrap_err()
        })?;
        Ok(Some(buf.as_slice(cx).to_vec()))
    } else {
        Ok(None)
    }
}

/// Helper for extracting a Vec<u8> from optional Buffer at [obj].[attr]
pub fn get_vec<'a, C, K>(
    cx: &mut C,
    obj: &Handle<JsObject>,
    attr: K,
    full_attr_path: &str,
) -> Result<Vec<u8>, neon::result::Throw>
where
    K: neon::object::PropertyKey + Display + Clone,
    C: Context<'a>,
{
    if let Some(val) = get_optional(cx, obj, attr.clone()) {
        let buf = val.downcast::<JsBuffer, C>(cx).map_err(|_| {
            cx.throw_type_error::<_, Option<Vec<u8>>>(format!("Invalid {}", attr))
                .unwrap_err()
        })?;
        Ok(buf.as_slice(cx).to_vec())
    } else {
        cx.throw_type_error::<_, Vec<u8>>(format!("Invalid or missing {}", full_attr_path))
    }
}
