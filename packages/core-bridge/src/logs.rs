use std::{
    collections::HashMap,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use neon::prelude::*;

use rand::{Rng, SeedableRng, distributions::Alphanumeric, rngs::StdRng, seq::SliceRandom};

use serde::{Serialize, ser::SerializeMap as _};
use serde_json::{Map as JsonMap, Value as JsonValue};
use temporal_sdk_core::api::telemetry::CoreLog;

use bridge_macros::js_function;

use crate::{
    helpers::properties::ObjectExt as _,
    helpers::{BridgeError, BridgeResult, IntoThrow, JsonString, TryIntoJs},
};

pub fn init(cx: &mut neon::prelude::ModuleContext) -> neon::prelude::NeonResult<()> {
    cx.export_function("getTimeOfDay", get_time_of_day)?;
    cx.export_function(
        "generateBenchmarkLogEntries",
        generate_benchmark_log_entries,
    )?;

    Ok(())
}

/// Helper to get the current time in nanosecond resolution. Nano seconds timestamps are
/// used to precisely sort logs emitted from the Workflow Context, main thread, and Core.
#[js_function]
pub fn get_time_of_day() -> BridgeResult<SystemTime> {
    Ok(SystemTime::now())
}

const BENCH_ENTRIES_PER_BATCH: usize = 10;
const BENCH_RANDOM_FIELDS: usize = 2;
const BENCH_SPAN_CONTEXTS: usize = 2;

#[derive(Debug)]
struct BenchmarkResult {
    direct: Option<Vec<LogEntry>>,
    json: Option<String>,
}

impl TryIntoJs for BenchmarkResult {
    type Output = JsObject;

    fn try_into_js<'cx>(self, cx: &mut impl Context<'cx>) -> JsResult<'cx, JsObject> {
        let obj = cx.empty_object();

        obj.set_property_from(cx, "direct", self.direct)?;
        obj.set_property_from(cx, "json", self.json)?;

        Ok(obj)
    }
}

#[derive(Debug, Clone, Copy)]
enum BenchmarkMode {
    Direct,
    Json,
}

impl BenchmarkMode {
    fn try_from_str(mode: &str) -> BridgeResult<Self> {
        match mode {
            "direct" => Ok(Self::Direct),
            "json" => Ok(Self::Json),
            other => Err(BridgeError::TypeError {
                field: Some("mode".to_string()),
                message: format!("Unsupported benchmark mode '{other}'"),
            }),
        }
    }
}

#[js_function]
pub fn generate_benchmark_log_entries(mode: String, seed: u64) -> BridgeResult<BenchmarkResult> {
    let mode = BenchmarkMode::try_from_str(mode.as_str())?;

    let mut rng = StdRng::seed_from_u64(seed);
    let entries = generate_random_log_entries(&mut rng, BENCH_ENTRIES_PER_BATCH);

    match mode {
        BenchmarkMode::Direct => Ok(BenchmarkResult {
            direct: Some(entries),
            json: None,
        }),
        BenchmarkMode::Json => {
            let json =
                serde_json::to_string(&entries).map_err(|err| BridgeError::Other(err.into()))?;
            Ok(BenchmarkResult {
                direct: None,
                json: Some(json),
            })
        }
    }
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

impl TryIntoJs for LogEntry {
    type Output = JsObject;

    fn try_into_js<'cx>(self, cx: &mut impl Context<'cx>) -> JsResult<'cx, JsObject> {
        let obj = cx.empty_object();
        obj.set_property_from(cx, "target", self.target)?;
        obj.set_property_from(cx, "message", self.message)?;
        obj.set_property_from(cx, "timestamp", self.timestamp)?;
        obj.set_property_from(cx, "level", self.level)?;

        let js_fields = cx.empty_object();
        for (key, value) in self.fields {
            let camel_key = snake_to_camel(&key);
            let js_value = json_value_to_js(cx, value)?;
            let js_key = cx.string(camel_key);
            js_fields.set(cx, js_key, js_value)?;
        }
        obj.set_property(cx, "fields", js_fields)?;
        obj.set_property_from(cx, "spanContexts", self.span_contexts)?;

        Ok(obj)
    }
}

fn json_value_to_js<'cx>(cx: &mut impl Context<'cx>, value: JsonValue) -> JsResult<'cx, JsValue> {
    match value {
        JsonValue::Null => Ok(cx.null().upcast()),
        JsonValue::Bool(b) => Ok(cx.boolean(b).upcast()),
        JsonValue::Number(n) => {
            if let Some(i) = n.as_i64() {
                Ok(cx.number(i as f64).upcast())
            } else if let Some(u) = n.as_u64() {
                Ok(cx.number(u as f64).upcast())
            } else if let Some(f) = n.as_f64() {
                Ok(cx.number(f).upcast())
            } else {
                Ok(cx.undefined().upcast())
            }
        }
        JsonValue::String(s) => Ok(cx.string(s).upcast()),
        JsonValue::Array(values) => {
            let array = cx.empty_array();
            for (idx, item) in values.into_iter().enumerate() {
                let js_value = json_value_to_js(cx, item)?;
                #[allow(clippy::cast_possible_truncation)]
                array.set(cx, idx as u32, js_value)?;
            }
            Ok(array.upcast())
        }
        JsonValue::Object(map) => {
            let obj = cx.empty_object();
            for (key, value) in map {
                let js_value = json_value_to_js(cx, value)?;
                let js_key = cx.string(snake_to_camel(&key));
                obj.set(cx, js_key, js_value)?;
            }
            Ok(obj.upcast())
        }
    }
}

fn generate_random_log_entries<R: Rng + ?Sized>(rng: &mut R, count: usize) -> Vec<LogEntry> {
    (0..count).map(|_| random_log_entry(rng)).collect()
}

fn random_log_entry<R: Rng + ?Sized>(rng: &mut R) -> LogEntry {
    const LOG_LEVELS: &[&str] = &["TRACE", "DEBUG", "INFO", "WARN", "ERROR"];

    let target = format!("bench.target.{}", random_string(rng, 6));
    let message = format!("Benchmark message {}", random_string(rng, 12));
    let level = (*LOG_LEVELS.choose(rng).unwrap_or(&"INFO")).to_string();
    let timestamp = rng.r#gen::<u128>().to_string();

    let mut fields = HashMap::with_capacity(BENCH_RANDOM_FIELDS);
    for idx in 0..BENCH_RANDOM_FIELDS {
        let key = format!("field_name_{idx}");
        fields.insert(key, random_log_field_value(rng, 0));
    }

    let span_contexts = (0..BENCH_SPAN_CONTEXTS)
        .map(|_| random_string(rng, 32))
        .collect();

    LogEntry {
        target,
        message,
        timestamp,
        level,
        fields,
        span_contexts,
    }
}

fn random_log_field_value<R: Rng + ?Sized>(rng: &mut R, depth: usize) -> JsonValue {
    const MAX_LOG_FIELD_DEPTH: usize = 2;

    if depth >= MAX_LOG_FIELD_DEPTH || rng.gen_bool(0.6) {
        return random_terminal_log_value(rng);
    }

    let mut nested = JsonMap::with_capacity(2);
    nested.insert(
        format!("nested_field_{}_a", depth),
        random_log_field_value(rng, depth + 1),
    );
    nested.insert(
        format!("nested_field_{}_b", depth),
        random_terminal_log_value(rng),
    );

    JsonValue::Object(nested)
}

fn random_terminal_log_value<R: Rng + ?Sized>(rng: &mut R) -> JsonValue {
    match rng.gen_range(0..3) {
        0 => {
            let len = rng.gen_range(8..16);
            JsonValue::String(random_string(rng, len))
        }
        1 => JsonValue::Number(serde_json::Number::from(rng.gen_range(0..10_000_i64))),
        _ => JsonValue::Bool(rng.gen_bool(0.5)),
    }
}

fn random_string<R: Rng + ?Sized>(rng: &mut R, len: usize) -> String {
    rng.sample_iter(&Alphanumeric)
        .take(len)
        .map(char::from)
        .collect()
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
