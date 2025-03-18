use crate::{future::BridgeFuture, helpers::*, runtime::RuntimeHandle};
use bridge_macros::js_function;
use config::BridgeClientOptions;
use neon::{context::Context, prelude::*};
use std::cell::RefCell;
use temporal_client::{ClientInitError, ConfiguredClient, TemporalServiceClientWithMetrics};
use temporal_sdk_core::RetryClient;

use neon::handle::Handle;
use std::collections::HashMap;
use temporal_sdk_core::ClientOptions as CoreClientOptions;

////////////////////////////////////////////////////////////////////////////////////////////////////

/// This is the type that we actually pass to the lang side.
///
/// - JsBox: So that we're informed if the object is dropped by the lang GC
/// - RefCell: For interior mutability
/// - Option: So that we can take it out of the box on close (requires mutability ^^^)
/// - ClientHandle: The actual bridge client handle (below)
// pub type BoxedClientRef = JsBox<RefCell<Option<ClientHandle>>>;
pub type BoxedClientRef = JsBox<RefCell<Option<ClientHandle>>>;

#[derive(Clone)]
pub struct ClientHandle {
    pub(crate) runtime_handle: RuntimeHandle,
    pub(crate) core_client: CoreClient,
}

impl Finalize for ClientHandle {}

type CoreClient = RetryClient<ConfiguredClient<TemporalServiceClientWithMetrics>>;

impl TryFromJs for ClientHandle {
    fn try_from_js<'cx, 'b>(
        cx: &mut impl Context<'cx>,
        js_value: Handle<'b, JsValue>,
    ) -> BridgeResult<Self> {
        let client = js_value.downcast::<BoxedClientRef, _>(cx)?;
        let client = client.borrow();
        Ok(client
            .as_ref()
            .ok_or(BridgeError::IllegalStateAlreadyClosed { what: "Client" })?
            .clone())
    }
}

impl TryIntoJs for ClientHandle {
    type Output = BoxedClientRef;
    fn try_into_js<'a>(self, cx: &mut impl Context<'a>) -> JsResult<'a, BoxedClientRef> {
        Ok(cx.boxed(RefCell::new(Some(self.clone()))))
    }
}

////////////////////////////////////////////////////////////////////////////////////////////////////

/// Create a connected gRPC client which can be used to initialize workers.
#[js_function]
pub fn client_new(
    runtime: RuntimeHandle,
    client_options: BridgeClientOptions,
) -> BridgeResult<BridgeFuture<ClientHandle>> {
    let client_options: CoreClientOptions = client_options.try_into()?;

    runtime.clone().future_to_promise(async move {
        let metric_meter = runtime.core_runtime.telemetry().get_temporal_metric_meter();

        let res = client_options.connect_no_namespace(metric_meter).await;

        let core_client = match res {
            Ok(core_client) => core_client,
            Err(ClientInitError::SystemInfoCallError(e)) => Err(BridgeError::TransportError(
                format!("Failed to call GetSystemInfo: {}", e),
            ))?,
            Err(ClientInitError::TonicTransportError(e)) => {
                Err(BridgeError::TransportError(format!("{:?}", e)))?
            }
            Err(ClientInitError::InvalidUri(e)) => Err(BridgeError::TypeError {
                message: e.to_string(),
                field: None,
            })?,
        };

        Ok(ClientHandle {
            runtime_handle: runtime,
            core_client,
        })
    })
}

/// Update a Client's HTTP request headers
#[js_function]
pub fn client_update_headers(
    client: ClientHandle,
    headers: HashMap<String, String>,
) -> BridgeResult<()> {
    client.core_client.get_client().set_headers(headers);
    Ok(())
}

/// Update a Client's API key
#[js_function]
pub fn client_update_api_key(client: ClientHandle, key: String) -> BridgeResult<()> {
    client.core_client.get_client().set_api_key(Some(key));
    Ok(())
}

/// Drop a reference to a Client, once all references are dropped, the Client will be closed.
pub fn client_close(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let client = cx.argument::<BoxedClientRef>(0)?;

    client_close_impl(client).into_throw(&mut cx)?;
    Ok(cx.undefined())
}

/// Drop a reference to a Client, once all references are dropped, the Client will be closed.
pub fn client_close_impl(client: Handle<JsBox<RefCell<Option<ClientHandle>>>>) -> BridgeResult<()> {
    if client.take().is_none() {
        Err(BridgeError::IllegalStateAlreadyClosed { what: "Client" })?;
    }
    Ok(())
}

// Work in progress - Do not touch
//
// impl TryFromJs for RefMut<'_, Option<ClientHandle>> {
//     fn try_from_js<'a>(
//         cx: &mut impl Context<'a>,
//         js_value: Handle<'a, JsValue>,
//     ) -> BridgeResult<Self> {
//         let client = js_value.downcast::<BoxedClientRef, _>(cx)?;
//         let client = client.borrow_mut();
//         Ok(client)
//     }
// }
//
// #[repr(transparent)]
// struct Wrapped<'a>(Handle<'a, JsBox<RefCell<Option<ClientHandle>>>>);
//
// impl<'a> std::ops::Deref for Wrapped<'a> {
//     type Target = Option<ClientHandle>;
//
//     fn deref(&self) -> &Self::Target {
//         self.0.borrow().deref()
//     }
// }
//
// impl<'a> std::ops::DerefMut for Wrapped<'a> {
//     type Target = Option<ClientHandle>;
//
//     fn deref_mut(&mut self) -> &mut Self::Target {
//         self.0.borrow_mut().deref_mut()
//     }
// }
//
// impl<'a> Wrapped<'a> {
//     fn borrow(&self) -> &Option<ClientHandle> {
//         self.0.borrow().deref()
//     }
//
//     fn borrow_mut(&mut self) -> &mut Option<ClientHandle> {
//         self.0.borrow_mut().deref_mut()
//     }
// }
//
// /// Drop a reference to a Client, once all references are dropped, the Client will be closed.
// pub fn client_close(mut cx: FunctionContext) -> BridgeResult<()> {
//     let client_box = cx.argument::<JsValue>(0)?;
//     let client_box = client_box.downcast::<BoxedClientRef, _>(&mut cx)?;
//     let mut client_box = Wrapped(client_box);
//
//     client_close_impl(client_box.0.borrow_mut().deref_mut())
// }
//
// /// Drop a reference to a Client, once all references are dropped, the Client will be closed.
// pub fn client_close_impl(client_box: &mut Option<ClientHandle>) -> BridgeResult<()> {
//     if client_box.take().is_none() {
//         Err(BridgeError::IllegalStateAlreadyClosed { what: "Client" })?;
//     }
//
//     Ok(())
// }

////////////////////////////////////////////////////////////////////////////////////////////////////

mod config {
    use crate::helpers::*;
    use bridge_macros::TryFromJs;
    use temporal_sdk_core::Url;

    use anyhow::Context as AnyhowContext;
    use std::collections::HashMap;
    use temporal_client::HttpConnectProxyOptions;
    use temporal_sdk_core::{
        ClientOptions as CoreClientOptions, ClientOptionsBuilder, ClientTlsConfig,
        TlsConfig as CoreTlsConfig,
    };

    #[derive(Debug, Clone, TryFromJs)]
    pub struct BridgeClientOptions {
        url: Url,
        sdk_version: String,
        tls: Option<TlsConfig>,
        proxy: Option<ProxyConfig>,
        metadata: Option<HashMap<String, String>>,
        api_key: Option<String>,
        disable_error_code_metric_tags: bool,
    }

    impl TryInto<CoreClientOptions> for BridgeClientOptions {
        type Error = BridgeError;

        fn try_into(self) -> Result<CoreClientOptions, Self::Error> {
            let mut builder = ClientOptionsBuilder::default();

            if let Some(tls) = self.tls {
                builder.tls_cfg(tls.try_into()?);
            }

            if let Some(proxy) = self.proxy {
                builder.http_connect_proxy(Some(proxy.try_into()?));
            }

            let client_options = builder
                .target_url(self.url)
                .client_name("temporal-typescript".to_string())
                .client_version(self.sdk_version)
                .headers(self.metadata)
                .api_key(self.api_key)
                .disable_error_code_metric_tags(self.disable_error_code_metric_tags)
                .build()
                .context("Invalid client options")?;

            Ok(client_options)
        }
    }

    #[derive(Debug, Clone, TryFromJs)]
    struct TlsConfig {
        server_name_override: Option<String>,
        server_root_ca_certificate: Option<Vec<u8>>,
        client_cert_pair: Option<ClientTlsConfigPair>,
    }

    #[derive(Debug, Clone, TryFromJs)]
    struct ClientTlsConfigPair {
        crt: Vec<u8>,
        key: Vec<u8>,
    }

    impl TryInto<CoreTlsConfig> for TlsConfig {
        type Error = BridgeError;

        fn try_into(self) -> Result<CoreTlsConfig, Self::Error> {
            Ok(CoreTlsConfig {
                server_root_ca_cert: self.server_root_ca_certificate,
                domain: self.server_name_override,
                client_tls_config: self.client_cert_pair.map(|pair| ClientTlsConfig {
                    client_cert: pair.crt,
                    client_private_key: pair.key,
                }),
            })
        }
    }

    #[derive(Debug, Clone, TryFromJs)]
    struct ProxyConfig {
        target_host: String,
        basic_auth: Option<ProxyBasicAuth>,
    }

    #[derive(Debug, Clone, TryFromJs)]
    struct ProxyBasicAuth {
        username: String,
        password: String,
    }

    impl TryInto<HttpConnectProxyOptions> for ProxyConfig {
        type Error = BridgeError;

        fn try_into(self) -> Result<HttpConnectProxyOptions, Self::Error> {
            Ok(HttpConnectProxyOptions {
                target_addr: self.target_host,
                basic_auth: self.basic_auth.map(|auth| (auth.username, auth.password)),
            })
        }
    }
}
