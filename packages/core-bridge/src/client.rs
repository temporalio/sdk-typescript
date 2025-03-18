use std::{collections::HashMap, sync::Arc};

use neon::prelude::*;

use temporal_client::{ClientInitError, ConfiguredClient, TemporalServiceClientWithMetrics};
use temporal_sdk_core::{ClientOptions as CoreClientOptions, CoreRuntime, RetryClient};

use bridge_macros::js_function;

use crate::runtime::Runtime;
use crate::{helpers::*, runtime::RuntimeExt as _};

////////////////////////////////////////////////////////////////////////////////////////////////////

type CoreClient = RetryClient<ConfiguredClient<TemporalServiceClientWithMetrics>>;

pub struct Client {
    // These fields are pub because they are accessed from Worker::new
    pub(crate) core_runtime: Arc<CoreRuntime>,
    pub(crate) core_client: CoreClient,
}

impl Finalize for Client {}

////////////////////////////////////////////////////////////////////////////////////////////////////

pub fn init(cx: &mut neon::prelude::ModuleContext) -> neon::prelude::NeonResult<()> {
    cx.export_function("newClient", client_new)?;
    cx.export_function("clientUpdateHeaders", client_update_headers)?;
    cx.export_function("clientUpdateApiKey", client_update_api_key)?;
    cx.export_function("clientClose", client_close)?;

    Ok(())
}

/// Create a connected gRPC client which can be used to initialize workers.
#[js_function]
pub fn client_new(
    runtime: OpaqueInboundHandle<Runtime>,
    config: config::BridgeClientOptions,
) -> BridgeResult<BridgeFuture<OpaqueOutboundHandle<Client>>> {
    let runtime = runtime.borrow_inner()?.core_runtime.clone();
    let config: CoreClientOptions = config.try_into()?;

    runtime.clone().future_to_promise(async move {
        let metric_meter = runtime.clone().telemetry().get_temporal_metric_meter();

        let res = config.connect_no_namespace(metric_meter).await;

        let core_client = match res {
            Ok(core_client) => core_client,
            Err(ClientInitError::SystemInfoCallError(e)) => Err(BridgeError::TransportError(
                format!("Failed to call GetSystemInfo: {e}"),
            ))?,
            Err(ClientInitError::TonicTransportError(e)) => {
                Err(BridgeError::TransportError(format!("{e:?}")))?
            }
            Err(ClientInitError::InvalidUri(e)) => Err(BridgeError::TypeError {
                message: e.to_string(),
                field: None,
            })?,
        };

        Ok(OpaqueOutboundHandle::new(Client {
            core_runtime: runtime,
            core_client,
        }))
    })
}

/// Update a Client's HTTP request headers
#[js_function]
pub fn client_update_headers(
    client: OpaqueInboundHandle<Client>,
    headers: HashMap<String, String>,
) -> BridgeResult<()> {
    client
        .borrow_inner()?
        .core_client
        .get_client()
        .set_headers(headers);
    Ok(())
}

/// Update a Client's API key
#[js_function]
pub fn client_update_api_key(client: OpaqueInboundHandle<Client>, key: String) -> BridgeResult<()> {
    client
        .borrow_inner()?
        .core_client
        .get_client()
        .set_api_key(Some(key));
    Ok(())
}

#[js_function]
pub fn client_close(client: OpaqueInboundHandle<Client>) -> BridgeResult<()> {
    // Just drop the client; there's actually no "close" method on Client.
    let _client = client.take_inner()?;
    Ok(())
}

////////////////////////////////////////////////////////////////////////////////////////////////////

mod config {
    use std::collections::HashMap;

    use anyhow::Context as _;

    use temporal_client::HttpConnectProxyOptions;
    use temporal_sdk_core::{
        ClientOptions as CoreClientOptions, ClientOptionsBuilder, ClientTlsConfig,
        TlsConfig as CoreTlsConfig, Url,
    };

    use bridge_macros::TryFromJs;

    use crate::helpers::*;

    #[derive(Debug, Clone, TryFromJs)]
    pub(super) struct BridgeClientOptions {
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
