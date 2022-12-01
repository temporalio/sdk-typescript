use neon::prelude::*;

/// An unhandled error while communicating with the server, considered fatal
pub static TRANSPORT_ERROR: &str = "TransportError";
/// Thrown after shutdown was requested as a response to a poll function, JS should stop polling
/// once this error is encountered
pub static SHUTDOWN_ERROR: &str = "ShutdownError";
/// Something unexpected happened, considered fatal
pub static UNEXPECTED_ERROR: &str = "UnexpectedError";
/// Used in different parts of the project to signal that something unexpected has happened
pub static ILLEGAL_STATE_ERROR: &str = "IllegalStateError";

pub fn make_named_error_from_string<'a, C>(
    cx: &mut C,
    name: &str,
    message: impl Into<String>,
) -> JsResult<'a, JsError>
where
    C: Context<'a>,
{
    let error = cx.error(message.into()).unwrap();
    let name = cx.string(name);
    error.set(cx, "name", name)?;

    Ok(error)
}

pub fn make_named_error_from_error<'a, C, E>(
    cx: &mut C,
    name: &str,
    err: E,
) -> JsResult<'a, JsError>
where
    C: Context<'a>,
    E: std::error::Error,
{
    make_named_error_from_string(cx, name, format!("{:?}", err))
}
