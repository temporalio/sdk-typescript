use std::marker::PhantomData;

use neon::{prelude::Context, result::JsResult, types::JsString};
use serde::Serialize;
use serde_json;

use super::{BridgeError, TryIntoJs};

////////////////////////////////////////////////////////////////////////////////////////////////////

/// A newtype wrapper for a T serialized as a JSON string.
///
/// Creating objects through NAPI is incredibly slow in Node due to the fact that object data
/// layout is recalculated every time a property is added. So much that, surprisingly, transferring
/// Rust objects to JS by serializing them to JSON strings then deserializing them back in JS
/// using `JSON.parse` is on average twice as fast as creating those objects using NAPI calls
/// (claim from the Neon's author, circa April 2025).
///
/// This newtype wrapper allows specifying values that will be serialized to a JSON string
/// when being transferred to JS using the `TryIntoJs` trait. The JSON serialization happens
/// on the caller Rust thread, therefore limiting the time spent in the JS thread.
#[derive(Debug, Clone)]
pub struct JsonString<T> {
    json: String,
    _phantom: PhantomData<T>,
}

impl<T> JsonString<T>
where
    T: Serialize,
{
    pub fn try_from_value(value: T) -> Result<Self, BridgeError> {
        let json = serde_json::to_string(&value)
            .map_err(|e| BridgeError::Other(anyhow::Error::from(e)))?;
        Ok(Self {
            json,
            _phantom: PhantomData,
        })
    }
}

impl<T> TryIntoJs for JsonString<T> {
    type Output = JsString;
    fn try_into_js<'a>(self, cx: &mut impl Context<'a>) -> JsResult<'a, JsString> {
        Ok(cx.string(&self.json))
    }
}
