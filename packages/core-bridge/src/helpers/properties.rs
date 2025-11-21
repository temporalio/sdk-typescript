use neon::prelude::*;

use super::{AppendFieldContext as _, BridgeError, BridgeResult, TryFromJs, TryIntoJs};

/// Extension trait for `JsObject`.
pub trait ObjectExt: Object {
    /// Get a property from a JS Object, converting it to a Rust value using `TryFromJs`.
    ///
    /// Type errors will be reported with `field` set to the name of the property being
    /// accessed; it is expected that caller will prepend any additional path components
    /// that led to this object, to help identify the object that failed.
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

    /// Set a property on a JS Object, converting it from a Rust value using `TryIntoJs`.
    fn set_property_from<'cx, C: Context<'cx>, T: TryIntoJs>(
        &self,
        cx: &mut C,
        key: &str,
        value: T,
    ) -> NeonResult<()> {
        let key = cx.string(key);
        let value = value.try_into_js(cx)?;
        self.set(cx, key, value)?;
        Ok(())
    }

    /// Set a property on a JS Object, converting it from a Rust value using `TryIntoJs`.
    fn set_property<'cx, C: Context<'cx>, T: Value>(
        &self,
        cx: &mut C,
        key: &str,
        value: Handle<'cx, T>,
    ) -> NeonResult<()> {
        let key = cx.string(key);
        self.set(cx, key, value)?;
        Ok(())
    }
}

impl ObjectExt for JsObject {}
impl ObjectExt for JsError {}

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
