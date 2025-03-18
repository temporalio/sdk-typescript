mod abort_controller;
mod callbacks;
pub mod conversions;
mod errors;
pub mod primitives;

use neon::prelude::*;

pub use abort_controller::{AbortController, AbortSignal};
pub use callbacks::{JsAsyncCallback, JsCallback};
pub use errors::{
    AppendFieldContext, BridgeError, BridgeResult, CustomJavaScriptErrors, IntoThrow,
};
pub use primitives::{TryFromJs, TryIntoJs};
/// Extension trait for `JsObject` to get a property and convert it to a value using `TryFromJs`.
pub trait ObjectExt: Object {
    fn get_property_into<'cx, C: Context<'cx>, T: TryFromJs>(
        &self,
        cx: &mut C,
        key: &str,
    ) -> BridgeResult<T> {
        let value = self.get_value(cx, key)?;
        if value.is_a::<JsUndefined, _>(cx) {
            return Err(BridgeError::TypeError {
                message: format!("Missing property '{}'", key),
                field: Some(key.to_string()),
            });
        }
        <T>::try_from_js(cx, value).field(key)
    }
}

impl<'cx> ObjectExt for JsObject {}

pub use ObjectExt as _;

// Extension trait for `FunctionContext` to get a property and convert it to a value using `TryFromJs`.
pub trait FunctionContextExt {
    fn argument_into<T: TryFromJs>(&mut self, index: usize) -> BridgeResult<T>;
}

impl<'cx> FunctionContextExt for FunctionContext<'cx> {
    fn argument_into<T: TryFromJs>(&mut self, index: usize) -> BridgeResult<T> {
        let value = self.argument::<JsValue>(index)?;
        <T>::try_from_js(self, value).field(format!("args[{}]", index).as_str())
    }
}

pub use FunctionContextExt as _;
