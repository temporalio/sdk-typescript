use neon::{
    handle::Handle,
    prelude::Context,
    result::JsResult,
    types::{JsString, JsValue},
};
use serde::{Serialize, de::DeserializeOwned};
use serde_json;

use super::{BridgeError, BridgeResult, TryFromJs, TryIntoJs};

/// A newtype wrapper for a T serialized as a JSON string.
///
/// Creating objects through NAPI is incredibly slow in Node due to the fact that object data
/// layout is recalculated every time a property is added. So much that, surprisingly, transferring
/// Rust objects to JS by serializing them to JSON strings then deserializing them back in JS
/// using `JSON.parse` is on average twice as fast as creating those objects using NAPI calls
/// (claim from the Neon's author, circa April 2025).
///
/// This newtype wrapper allows specifying values that will be serialized to a JSON string
/// when being transferred to JS using the `TryIntoJs` trait, and to be deserialized from JSON
/// when being transferred from JS using the `TryFromJs` trait.
#[derive(Debug, Clone)]
pub struct JsonString<T> {
    pub json: String,
    pub value: T,
}

impl<T: Serialize> TryIntoJs for JsonString<T> {
    type Output = JsString;
    fn try_into_js<'a>(self, cx: &mut impl Context<'a>) -> JsResult<'a, JsString> {
        Ok(cx.string(&self.json))
    }
}

impl<T: Serialize> JsonString<T> {
    pub fn try_from_value(value: T) -> Result<Self, BridgeError> {
        let json = serde_json::to_string(&value)
            .map_err(|e| BridgeError::Other(anyhow::Error::from(e)))?;
        Ok(Self { json, value })
    }
}

impl<T: DeserializeOwned> TryFromJs for JsonString<T> {
    fn try_from_js<'cx, 'b>(
        cx: &mut impl Context<'cx>,
        js_value: Handle<'b, JsValue>,
    ) -> BridgeResult<Self> {
        let json = js_value.downcast::<JsString, _>(cx)?.value(cx);
        match serde_json::from_str(&json) {
            Ok(value) => Ok(Self { json, value }),
            Err(e) => Err(BridgeError::TypeError {
                field: None,
                message: e.to_string(),
            }),
        }
    }
}
