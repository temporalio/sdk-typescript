use crate::{
    conversions::*,
    errors::*,
    runtime::{BoxedRuntimeRef, RuntimeHandle},
};
use neon::{context::Context, prelude::*};
use std::{cell::RefCell, sync::Arc};
use temporal_client::{ClientInitError, ConfiguredClient, TemporalServiceClientWithMetrics};
use temporal_sdk_core::RetryClient;

use neon::{
    handle::Handle,
    types::{JsBoolean, JsNumber, JsString},
};
use std::{collections::HashMap, time::Duration};
use temporal_client::HttpConnectProxyOptions;
use temporal_sdk_core::{
    ClientOptions, ClientOptionsBuilder, ClientTlsConfig, RetryConfig, TlsConfig, Url,
};

////////////////////////////////////////////////////////////////////////////////////////////////////

/// This is the type that we actually pass to the lang side.
///
/// - JsBox: So that we're informed if the object is dropped by the lang GC
/// - RefCell: For interior mutability
/// - Option: So that we can take it out of the box on close (requires mutability ^^^)
/// - Arc: So that we can safely pass the ClientHandle around -- FIXME: Is this useful?
/// - ClientHandle: The actual bridge client handle (below)
pub type BoxedClientRef = JsBox<RefCell<Option<ClientHandle>>>;

pub struct ClientHandle {
    pub(crate) runtime_handle: Arc<RuntimeHandle>, // FIXME: Should we inline rather than Arc?
    pub(crate) core_client: CoreClient,
}

impl Finalize for ClientHandle {}

pub type CoreClient = RetryClient<ConfiguredClient<TemporalServiceClientWithMetrics>>;

////////////////////////////////////////////////////////////////////////////////////////////////////

/// Create a connected gRPC client which can be used to initialize workers.
pub fn client_new(mut cx: FunctionContext) -> JsResult<JsPromise> {
    let runtime = cx.argument::<BoxedRuntimeRef>(0)?;
    let runtime_ref = runtime.borrow();
    let runtime_handle = runtime_ref
        .as_ref()
        .expect("Tried to use Runtime after it has been shutdown")
        .clone();

    let client_options = cx.argument::<JsObject>(1)?.as_client_options(&mut cx)?;

    let (deferred, promise) = cx.promise();

    let metric_meter = runtime_handle
        .core_runtime
        .telemetry()
        .get_temporal_metric_meter();

    runtime_handle
        .core_runtime
        .tokio_handle()
        .spawn(async move {
            let result = client_options.connect_no_namespace(metric_meter).await;

            let cx_channel = runtime_handle.cx_channel.clone();
            deferred
                .try_settle_with(cx_channel.as_ref(), move |mut cx: TaskContext| {
                    let runtime_handle = runtime_handle.clone();
                    match result {
                        Ok(client) => {
                            let client_handle = ClientHandle {
                                runtime_handle: runtime_handle.clone(),
                                core_client: client,
                            };
                            Ok(cx.boxed(RefCell::new(Some(client_handle))))
                        }
                        Err(ClientInitError::SystemInfoCallError(e)) => cx.throw_transport_error(
                            format!("Failed to call GetSystemInfo: {}", e),
                        )?,
                        Err(ClientInitError::TonicTransportError(e)) => {
                            cx.throw_transport_error(e.to_string())?
                        }
                        Err(ClientInitError::InvalidUri(e)) => {
                            cx.throw_type_error(e.to_string())?
                        }
                    }
                })
                .unwrap(); // Not much we can do at this point. It's time to panic.
        });

    Ok(promise)
}

/// Update a Client's HTTP request headers
pub fn client_update_headers(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let client: Handle<BoxedClientRef> = cx.argument(0)?;
    let client_ref = client.borrow();
    let client_handle = client_ref
        .as_ref()
        .expect("Tried to use Client after it has been closed");

    let headers = cx
        .argument::<JsObject>(1)?
        .as_hash_map_of_string_to_string(&mut cx)?;

    client_handle.core_client.get_client().set_headers(headers);

    Ok(cx.undefined())
}

/// Update a Client's API key
pub fn client_update_api_key(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let client: Handle<BoxedClientRef> = cx.argument(0)?;
    let client_ref = client.borrow();
    let client_handle = client_ref
        .as_ref()
        .expect("Tried to use Client after it has been closed");

    let key = cx.argument::<JsString>(1)?.value(&mut cx);

    client_handle
        .core_client
        .get_client()
        .set_api_key(Some(key));

    Ok(cx.undefined())
}

/// Drop a reference to a Client, once all references are dropped, the Client will be closed.
pub fn client_close(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let client: Handle<BoxedClientRef> = cx.argument(0)?;

    if client.take().is_none() {
        cx.throw_illegal_state_error("Client has already been closed")?;
    }

    Ok(cx.undefined())
}

////////////////////////////////////////////////////////////////////////////////////////////////////

trait ClientOptionsConversions {
    fn as_client_options(&self, cx: &mut FunctionContext) -> NeonResult<ClientOptions>;
}

impl ClientOptionsConversions for Handle<'_, JsObject> {
    fn as_client_options(&self, cx: &mut FunctionContext) -> NeonResult<ClientOptions> {
        let url = match Url::parse(&js_value_getter!(cx, self, "url", JsString)) {
            Ok(url) => url,
            // Note that address is what's used in the Node side.
            Err(_) => cx.throw_type_error("Invalid serverOptions.address")?,
        };

        let tls_cfg = match js_optional_getter!(cx, self, "tls", JsObject) {
            None => None,
            Some(tls) => {
                let domain = js_optional_value_getter!(cx, &tls, "serverNameOverride", JsString);

                let server_root_ca_cert = get_optional_vec(cx, &tls, "serverRootCACertificate")?;
                let client_tls_config =
                    match js_optional_getter!(cx, &tls, "clientCertPair", JsObject) {
                        None => None,
                        Some(client_tls_obj) => Some(ClientTlsConfig {
                            client_cert: get_vec(
                                cx,
                                &client_tls_obj,
                                "crt",
                                "serverOptions.tls.clientCertPair.crt",
                            )?,
                            client_private_key: get_vec(
                                cx,
                                &client_tls_obj,
                                "key",
                                "serverOptions.tls.clientCertPair.crt",
                            )?,
                        }),
                    };

                Some(TlsConfig {
                    server_root_ca_cert,
                    domain,
                    client_tls_config,
                })
            }
        };

        let proxy_cfg = match js_optional_getter!(cx, self, "proxy", JsObject) {
            None => None,
            Some(proxy) => {
                let target_addr = js_value_getter!(cx, &proxy, "targetHost", JsString);

                let basic_auth = match js_optional_getter!(cx, &proxy, "basicAuth", JsObject) {
                    None => None,
                    Some(proxy_obj) => Some((
                        js_value_getter!(cx, &proxy_obj, "username", JsString),
                        js_value_getter!(cx, &proxy_obj, "password", JsString),
                    )),
                };

                Some(HttpConnectProxyOptions {
                    target_addr,
                    basic_auth,
                })
            }
        };

        let retry_config = match js_optional_getter!(cx, self, "retry", JsObject) {
            None => RetryConfig::default(),
            Some(ref retry_config) => RetryConfig {
                initial_interval: Duration::from_millis(js_value_getter!(
                    cx,
                    retry_config,
                    "initialInterval",
                    JsNumber
                ) as u64),
                randomization_factor: js_value_getter!(
                    cx,
                    retry_config,
                    "randomizationFactor",
                    JsNumber
                ),
                multiplier: js_value_getter!(cx, retry_config, "multiplier", JsNumber),
                max_interval: Duration::from_millis(js_value_getter!(
                    cx,
                    retry_config,
                    "maxInterval",
                    JsNumber
                ) as u64),
                max_elapsed_time: js_optional_value_getter!(
                    cx,
                    retry_config,
                    "maxElapsedTime",
                    JsNumber
                )
                .map(|val| Duration::from_millis(val as u64)),
                max_retries: js_value_getter!(cx, retry_config, "maxRetries", JsNumber) as usize,
            },
        };

        let mut client_options = ClientOptionsBuilder::default();
        if let Some(tls_cfg) = tls_cfg {
            client_options.tls_cfg(tls_cfg);
        }
        client_options.http_connect_proxy(proxy_cfg);
        let headers = match js_optional_getter!(cx, self, "metadata", JsObject) {
            None => None,
            Some(h) => Some(h.as_hash_map_of_string_to_string(cx).map_err(|reason| {
                cx.throw_type_error::<_, HashMap<String, String>>(format!(
                    "Invalid metadata: {}",
                    reason
                ))
                .unwrap_err()
            })?),
        };
        client_options.headers(headers);
        client_options.api_key(js_optional_value_getter!(cx, self, "apiKey", JsString));

        Ok(client_options
            .client_name("temporal-typescript".to_string())
            .client_version(js_value_getter!(cx, self, "sdkVersion", JsString))
            .target_url(url)
            .retry_config(retry_config)
            .disable_error_code_metric_tags(js_value_getter!(
                cx,
                self,
                "disableErrorCodeMetricTags",
                JsBoolean
            ))
            .build()
            .expect("Core server gateway options must be valid"))
    }
}
