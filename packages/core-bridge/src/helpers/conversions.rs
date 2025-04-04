use neon::{context::Context, handle::Handle, prelude::*};

// FIXME: Legacy code - This should all get removed very soon

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
pub fn log_js_object<'a, 'b, C: Context<'b>>(cx: &mut C, js_object: &Handle<'a, JsValue>) {
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
