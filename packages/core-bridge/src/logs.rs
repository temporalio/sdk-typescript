use std::{
    collections::HashMap,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use neon::prelude::*;

use serde::{Serialize, ser::SerializeMap as _};
use temporal_sdk_core::api::telemetry::CoreLog;

use bridge_macros::js_function;

use crate::helpers::{BridgeError, BridgeResult, IntoThrow, JsonString, TryIntoJs};

pub fn init(cx: &mut neon::prelude::ModuleContext) -> neon::prelude::NeonResult<()> {
    cx.export_function("getTimeOfDay", get_time_of_day)?;

    Ok(())
}

/// Helper to get the current time in nanosecond resolution. Nano seconds timestamps are
/// used to precisely sort logs emitted from the Workflow Context, main thread, and Core.
#[js_function]
pub fn get_time_of_day() -> BridgeResult<SystemTime> {
    Ok(SystemTime::now())
}

#[derive(Debug, Clone, Serialize)]
pub struct LogEntry {
    pub target: String,
    pub message: String,
    pub timestamp: String, // u128 as a string - JSON doesn't support u128 numbers
    pub level: String,

    #[serde(serialize_with = "serialize_map_as_camel_case")]
    pub fields: HashMap<String, serde_json::Value>,
    pub span_contexts: Vec<String>,
}

impl TryFrom<CoreLog> for JsonString<LogEntry> {
    type Error = BridgeError;

    fn try_from(core_log: CoreLog) -> BridgeResult<Self> {
        let timestamp = core_log
            .timestamp
            .duration_since(UNIX_EPOCH)
            .unwrap_or(Duration::ZERO)
            .as_nanos();

        Self::try_from_value(LogEntry {
            target: core_log.target,
            message: core_log.message,
            timestamp: timestamp.to_string(),
            level: core_log.level.to_string(),
            fields: core_log.fields,
            span_contexts: core_log.span_contexts,
        })
    }
}

/// Serialize a map, converting keys to camel case.
fn serialize_map_as_camel_case<S>(
    value: &HashMap<String, serde_json::Value>,
    serializer: S,
) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    let mut map = serializer.serialize_map(Some(value.len()))?;
    for (k, v) in value {
        map.serialize_entry(&snake_to_camel(k), v)?;
    }
    map.end()
}

/// Convert a string from snake case to camel case.
fn snake_to_camel(input: &str) -> String {
    match input.find('_') {
        None => input.to_string(),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snake_to_camel_works() {
        assert_eq!(snake_to_camel("this_is_a_test"), "thisIsATest");
        assert_eq!(snake_to_camel("this___IS_a_TEST"), "thisIsATest");
        assert_eq!(snake_to_camel("éàç_this_is_a_test"), "éàçThisIsATest");
    }
}
