use std::collections::HashMap;

use bridge_macros::{TryIntoJs, js_function};
use neon::prelude::*;
use serde::Serialize;
use temporal_sdk_core_api::envconfig::{
    self, ClientConfig as CoreClientConfig, ClientConfigCodec as CoreClientConfigCodec,
    ClientConfigProfile as CoreClientConfigProfile, ClientConfigTLS as CoreClientConfigTLS,
    DataSource as CoreDataSource,
};

use crate::helpers::{BridgeError, BridgeResult};

pub fn init(cx: &mut ModuleContext) -> NeonResult<()> {
    cx.export_function("loadClientConfig", load_client_config)?;
    cx.export_function("loadClientConnectConfig", load_client_connect_config)?;
    Ok(())
}

impl From<envconfig::ConfigError> for BridgeError {
    fn from(e: envconfig::ConfigError) -> Self {
        Self::TypeError {
            field: None,
            message: e.to_string(),
        }
    }
}

#[derive(TryIntoJs, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientConfig {
    profiles: HashMap<String, ClientConfigProfile>,
}

impl From<CoreClientConfig> for ClientConfig {
    fn from(c: CoreClientConfig) -> Self {
        Self {
            profiles: c.profiles.into_iter().map(|(k, v)| (k, v.into())).collect(),
        }
    }
}

#[derive(TryIntoJs, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientConfigProfile {
    address: Option<String>,
    namespace: Option<String>,
    api_key: Option<String>,
    tls: Option<ClientConfigTls>,
    codec: Option<ClientConfigCodec>,
    grpc_meta: HashMap<String, String>,
}

impl From<CoreClientConfigProfile> for ClientConfigProfile {
    fn from(c: CoreClientConfigProfile) -> Self {
        Self {
            address: c.address,
            namespace: c.namespace,
            api_key: c.api_key,
            tls: c.tls.map(Into::into),
            codec: c.codec.map(Into::into),
            grpc_meta: c.grpc_meta,
        }
    }
}

#[derive(TryIntoJs, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientConfigTls {
    disabled: bool,
    client_cert: Option<DataSource>,
    client_key: Option<DataSource>,
    server_ca_cert: Option<DataSource>,
    server_name: Option<String>,
    disable_host_verification: bool,
}

impl From<CoreClientConfigTLS> for ClientConfigTls {
    fn from(c: CoreClientConfigTLS) -> Self {
        Self {
            disabled: c.disabled,
            client_cert: c.client_cert.map(Into::into),
            client_key: c.client_key.map(Into::into),
            server_ca_cert: c.server_ca_cert.map(Into::into),
            server_name: c.server_name,
            disable_host_verification: c.disable_host_verification,
        }
    }
}

#[derive(TryIntoJs, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientConfigCodec {
    endpoint: Option<String>,
    auth: Option<String>,
}

impl From<CoreClientConfigCodec> for ClientConfigCodec {
    fn from(c: CoreClientConfigCodec) -> Self {
        Self {
            endpoint: c.endpoint,
            auth: c.auth,
        }
    }
}

#[derive(TryIntoJs, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct DataSource {
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Vec<u8>>,
}

impl From<CoreDataSource> for DataSource {
    fn from(c: CoreDataSource) -> Self {
        match c {
            CoreDataSource::Path(p) => Self {
                path: Some(p),
                data: None,
            },
            CoreDataSource::Data(d) => Self {
                path: None,
                data: Some(d),
            },
        }
    }
}

// Bridge functions ////////////////////////////////////////////////////////////////////////////////

/// Load all client profiles from given sources
#[js_function]
fn load_client_config(
    path: Option<String>,
    data: Option<Vec<u8>>,
    disable_file: bool,
    config_file_strict: bool,
    env_vars: Option<HashMap<String, String>>,
) -> BridgeResult<ClientConfig> {
    let config_source = match (path, data) {
        (Some(p), None) => Some(CoreDataSource::Path(p)),
        (None, Some(d)) => Some(CoreDataSource::Data(d)),
        (None, None) => None,
        (Some(_), Some(_)) => {
            return Err(BridgeError::TypeError {
                field: None,
                message: "Cannot specify both path and data for config source".to_string(),
            });
        }
    };

    let core_config = if disable_file {
        CoreClientConfig::default()
    } else {
        let options = envconfig::LoadClientConfigOptions {
            config_source,
            config_file_strict,
        };
        envconfig::load_client_config(options, env_vars.as_ref())?
    };

    Ok(core_config.into())
}

/// Load a single client profile
#[js_function]
fn load_client_connect_config(
    profile: Option<String>,
    path: Option<String>,
    data: Option<Vec<u8>>,
    disable_file: bool,
    disable_env: bool,
    config_file_strict: bool,
    env_vars: Option<HashMap<String, String>>,
) -> BridgeResult<ClientConfigProfile> {
    let config_source = match (path, data) {
        (Some(p), None) => Some(CoreDataSource::Path(p)),
        (None, Some(d)) => Some(CoreDataSource::Data(d)),
        (None, None) => None,
        (Some(_), Some(_)) => {
            return Err(BridgeError::TypeError {
                field: None,
                message: "Cannot specify both path and data for config source".to_string(),
            });
        }
    };

    let options = envconfig::LoadClientConfigProfileOptions {
        config_source,
        config_file_profile: profile,
        config_file_strict,
        disable_file,
        disable_env,
    };

    let profile = envconfig::load_client_config_profile(options, env_vars.as_ref())?;

    Ok(profile.into())
}
