use neon::prelude::*;

use super::{AppendFieldContext as _, BridgeError, BridgeResult, TryFromJs};

/// Extension trait for `JsObject` that adds a method to get a property and convert
/// it to a value using `TryFromJs`.
///
/// Type errors will be reported with `field` set to the name of the property being
/// accessed; it is expected that caller will prepend any additional path components
/// that led to this object, to help identify the object that failed.
pub trait ObjectExt: Object {
    fn get_property_into<'cx, C: Context<'cx>, T: TryFromJs>(
        &self,
        cx: &mut C,
        key: &str,
    ) -> BridgeResult<T> {
        let value = self.get_value(cx, key)?;
        if value.is_a::<JsUndefined, _>(cx) {
            return Err(BridgeError::TypeError {
                message: format!("Missing property '{key}'"),
                field: Some(key.to_string()),
            });
        }
        <T>::try_from_js(cx, value).field(key)
    }
}

impl ObjectExt for JsObject {}

/// Extension trait for `FunctionContext` that adds a method to get an argument and
/// convert it to a value using `TryFromJs`.
///
/// Type errors will be reported with field name `args[index]`; it is expected that
/// caller will prepend the function name to the error message's `field` to help identify
/// the function that failed.
pub trait FunctionContextExt {
    fn argument_into<T: TryFromJs>(&mut self, index: usize) -> BridgeResult<T>;
}

impl FunctionContextExt for FunctionContext<'_> {
    fn argument_into<T: TryFromJs>(&mut self, index: usize) -> BridgeResult<T> {
        let value = self.argument::<JsValue>(index)?;
        <T>::try_from_js(self, value).field(format!("args[{index}]").as_str())
    }
}
