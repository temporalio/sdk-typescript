use crate::conversions::*;
use crate::errors::*;
use crate::helpers::*;
use crate::runtime::{BoxedEphemeralServer, BoxedRuntime, RuntimeRequest};
use neon::prelude::*;

// Below are functions exported to JS

/// Start an ephemeral Temporal server
pub fn start_ephemeral_server(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let runtime = cx.argument::<BoxedRuntime>(0)?;
    let config = cx.argument::<JsObject>(1)?;
    let sdk_version = cx.argument::<JsString>(2)?.value(&mut cx);
    let callback = cx.argument::<JsFunction>(3)?;

    let config = config.as_ephemeral_server_config(&mut cx, sdk_version)?;
    let request = RuntimeRequest::StartEphemeralServer {
        runtime: (**runtime).clone(),
        config,
        callback: callback.root(&mut cx),
    };
    if let Err(err) = runtime.sender.send(request) {
        callback_with_unexpected_error(&mut cx, callback, err)?;
    };

    Ok(cx.undefined())
}

/// Get the ephemeral server "target" (address:port string)
pub fn get_ephemeral_server_target(mut cx: FunctionContext) -> JsResult<JsString> {
    let server = cx.argument::<BoxedEphemeralServer>(0)?;
    let target = server
        .borrow()
        .as_ref()
        .map(|s| cx.string(s.core_server.blocking_lock().target.as_str()));
    if target.is_none() {
        make_named_error_from_string(
            &mut cx,
            ILLEGAL_STATE_ERROR,
            "Tried to use closed test server",
        )
        .and_then(|err| cx.throw(err))?;
    };
    Ok(target.unwrap())
}

/// Shutdown an ephemeral server - consumes the server
pub fn shutdown_ephemeral_server(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let server = cx.argument::<BoxedEphemeralServer>(0)?;
    let callback = cx.argument::<JsFunction>(1)?;
    // Drop the ref
    match server.replace(None) {
        None => {
            callback_with_unexpected_error(&mut cx, callback, "Tried to use closed test server")?;
        }
        Some(server) => {
            if let Err(err) = server
                .runtime
                .sender
                .send(RuntimeRequest::ShutdownEphemeralServer {
                    server: server.core_server.clone(),
                    callback: callback.root(&mut cx),
                })
            {
                callback_with_unexpected_error(&mut cx, callback, err)?;
            };
        }
    }
    Ok(cx.undefined())
}
