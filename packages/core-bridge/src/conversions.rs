use neon::{
    context::Context,
    handle::Handle,
    prelude::*,
    types::{buffer::TypedArray, JsNumber, JsString},
};
use std::{collections::HashMap, fmt::Display};

pub trait ArrayHandleConversionsExt {
    fn to_vec_of_string(&self, cx: &mut FunctionContext) -> NeonResult<Vec<String>>;
    fn to_vec_of_float(&self, cx: &mut FunctionContext) -> NeonResult<Vec<f64>>;
}

impl ArrayHandleConversionsExt for Handle<'_, JsArray> {
    fn to_vec_of_string(&self, cx: &mut FunctionContext) -> NeonResult<Vec<String>> {
        let js_vec = self.to_vec(cx)?;
        let len = js_vec.len();
        let mut ret_vec = Vec::<String>::with_capacity(len);

        for i in js_vec.iter().take(len) {
            ret_vec.push(i.downcast_or_throw::<JsString, _>(cx)?.value(cx));
        }
        Ok(ret_vec)
    }

    fn to_vec_of_float(&self, cx: &mut FunctionContext) -> NeonResult<Vec<f64>> {
        let js_vec = self.to_vec(cx)?;
        let len = js_vec.len();
        let mut ret_vec = Vec::<f64>::with_capacity(len);

        for i in js_vec.iter().take(len) {
            ret_vec.push(i.downcast_or_throw::<JsNumber, _>(cx)?.value(cx));
        }
        Ok(ret_vec)
    }
}

pub(crate) trait ObjectHandleConversionsExt {
    fn set_default(&self, cx: &mut FunctionContext, key: &str, value: &str) -> NeonResult<()>;
    fn as_hash_map_of_string_to_string(
        &self,
        cx: &mut FunctionContext,
    ) -> NeonResult<HashMap<String, String>>;
    fn as_hash_map_of_string_to_vec_of_floats(
        &self,
        cx: &mut FunctionContext,
    ) -> NeonResult<HashMap<String, Vec<f64>>>;
}

impl ObjectHandleConversionsExt for Handle<'_, JsObject> {
    fn as_hash_map_of_string_to_string(
        &self,
        cx: &mut FunctionContext,
    ) -> NeonResult<HashMap<String, String>> {
        let props = self.get_own_property_names(cx)?;
        let props = props.to_vec(cx)?;
        let mut map = HashMap::new();
        for k in props {
            let k = k.to_string(cx)?;
            let v = self.get::<JsString, _, _>(cx, k)?.value(cx);
            let k = k.value(cx);
            map.insert(k, v);
        }
        Ok(map)
    }

    fn as_hash_map_of_string_to_vec_of_floats(
        &self,
        cx: &mut FunctionContext,
    ) -> NeonResult<HashMap<String, Vec<f64>>> {
        let props = self.get_own_property_names(cx)?;
        let props = props.to_vec(cx)?;
        let mut map = HashMap::new();
        for k in props {
            let k = k.to_string(cx)?;
            let v = self.get::<JsArray, _, _>(cx, k)?.to_vec_of_float(cx)?;
            let k = k.value(cx);
            map.insert(k, v);
        }
        Ok(map)
    }

    fn set_default(&self, cx: &mut FunctionContext, key: &str, value: &str) -> NeonResult<()> {
        let key = cx.string(key);
        let existing: Option<Handle<JsString>> = self.get_opt(cx, key)?;
        if existing.is_none() {
            let value = cx.string(value);
            self.set(cx, key, value)?;
        }
        Ok(())
    }
}

////////////////////////////////////////////////////////////
// Getters
////////////////////////////////////////////////////////////

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

macro_rules! js_getter {
    ($js_cx:expr, $js_obj:expr, $prop_name:expr, $js_type:ty) => {
        match get_optional($js_cx, $js_obj, $prop_name) {
            None => $js_cx.throw_type_error(format!("{} must be defined", $prop_name))?,
            Some(val) => {
                if val.is_a::<$js_type, _>($js_cx) {
                    val.downcast_or_throw::<$js_type, _>($js_cx)?
                } else {
                    $js_cx.throw_type_error(format!("Invalid {}", $prop_name))?
                }
            }
        }
    };
}

pub(crate) use js_getter;

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

/// Helper for extracting an attribute from [obj] that may be undefined.
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

// Recursively convert a Serde value to a JS value
pub fn serde_value_to_js_value<'a>(
    cx: &mut impl Context<'a>,
    val: serde_json::Value,
) -> JsResult<'a, JsValue> {
    match val {
        serde_json::Value::String(s) => Ok(cx.string(s).upcast()),
        serde_json::Value::Number(n) => Ok(cx.number(n.as_f64().unwrap()).upcast()),
        serde_json::Value::Bool(b) => Ok(cx.boolean(b).upcast()),
        serde_json::Value::Null => Ok(cx.null().upcast()),
        serde_json::Value::Array(vec) => {
            let arr: Handle<'a, JsArray> = JsArray::new(cx, vec.len());
            for (i, v) in vec.into_iter().enumerate() {
                let v = serde_value_to_js_value(cx, v)?;
                arr.set(cx, i as u32, v)?;
            }
            Ok(arr.upcast())
        }
        serde_json::Value::Object(map) => hashmap_to_js_value(cx, map).map(|v| v.upcast()),
    }
}

pub fn hashmap_to_js_value<'a>(
    cx: &mut impl Context<'a>,
    map: impl IntoIterator<Item = (String, serde_json::Value)>,
) -> JsResult<'a, JsObject> {
    let obj: Handle<'a, JsObject> = cx.empty_object();
    for (k, v) in map {
        let k = cx.string(snake_to_camel(k));
        let v = serde_value_to_js_value(cx, v)?;
        obj.set(cx, k, v)?;
    }
    Ok(obj)
}

fn snake_to_camel(input: String) -> String {
    match input.find('_') {
        None => input,
        Some(first) => {
            let mut result = String::with_capacity(input.len());
            if first > 0 {
                result.push_str(&input[..first]);
            }
            let mut capitalize = true;
            for c in input[first + 1..].chars() {
                if c == '_' {
                    capitalize = true;
                } else if capitalize {
                    result.push(c.to_ascii_uppercase());
                    capitalize = false;
                } else {
                    result.push(c.to_ascii_lowercase());
                }
            }
            result
        }
    }
}

#[allow(dead_code)]
// Useful to help debug JSObject contents
pub fn log_js_object<'a, 'b, C: Context<'b>>(cx: &mut C, js_object: &Handle<'a, JsObject>) {
    let global = cx.global_object();
    let console = global
        .get::<JsObject, _, _>(cx, "console")
        .expect("Failed to get console object");

    let log = console
        .get::<JsFunction, _, _>(cx, "log")
        .expect("Failed to get log function");

    let args = vec![js_object.upcast()]; // Upcast js_object to JsValue
    log.call(cx, console, args)
        .expect("Failed to call console.log");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snake_to_camel_works() {
        assert_eq!(snake_to_camel("this_is_a_test".into()), "thisIsATest");
        assert_eq!(snake_to_camel("this___IS_a_TEST".into()), "thisIsATest");
        assert_eq!(
            snake_to_camel("éàç_this_is_a_test".into()),
            "éàçThisIsATest"
        );
    }
}
