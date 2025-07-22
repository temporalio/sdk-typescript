use std::cell::RefCell;

use anyhow::Error as AnyhowError;
use neon::{handle::DowncastError, prelude::*, result::Throw};
use tracing::warn;

use super::TryIntoJs;

/// A specialized Result type for errors that can be rethrown as a JS error.
pub type BridgeResult<T> = Result<T, BridgeError>;

/// Errors that can be rethrown by the Bridge as JS errors.
#[derive(Debug, thiserror::Error)]
#[allow(clippy::option_if_let_else)]
pub enum BridgeError {
    /// General error related to conversion between JS and Rust types.
    ///
    /// Use `BridgeResult::field()` to prepend a field name to the error while
    /// while propagating the error up through call stack.
    ///
    /// Becomes a JS `TypeError`.
    #[error("{}{message}", field_prefix(.field.as_ref()))]
    TypeError {
        field: Option<String>,
        message: String,
    },

    /// A specific variant of type errors that indicates that a JS provided object
    /// that is expected to be an enum variant carries an invalid `type` value.
    ///
    /// Use `BridgeResult::field()` to prepend a field name to the error while
    /// while propagating the error up through call stack. Doing so will implicitly
    /// convert the error into the more generic `TypeError` variant.
    ///
    /// Becomes a JS `TypeError`.
    #[error("Invalid variant '{variant}' for enum {enum_name}")]
    InvalidVariant { enum_name: String, variant: String },

    /// Error when a transport error occurs.
    ///
    /// Becomes a JS `TransportError`.
    #[error("{0}")]
    TransportError(String),

    /// Error when a resource is still in use while it shouldn't be.
    ///
    /// Becomes a JS `IllegalStateError`.
    #[error("{what} still in use{}", details_suffix(.details.as_ref()))]
    IllegalStateStillInUse {
        what: &'static str,
        details: Option<String>,
    },

    /// Error when a resource is already closed while it shouldn't be.
    ///
    /// Becomes a JS `IllegalStateError`.
    #[error("{what} already closed")]
    IllegalStateAlreadyClosed { what: &'static str },

    /// Something unexpected happened, considered fatal.
    ///
    /// Becomes a JS `UnexpectedError`.
    #[error("Unexpected error: {0}")]
    UnexpectedError(String),

    /// An error used to inform the JS side that a worker has completed draining
    /// pending tasks of a certain type. This is really just a poison pill, not
    /// an actual error.
    ///
    /// Becomes a JS `ShutdownError`.
    #[error("Worker has been shutdown")]
    WorkerShutdown,

    /// A gRPC call failed. The error carries the gRPC status code, message, and other details.
    ///
    /// Becomes a JS `ServiceError` (adhering to the same interface as `grpc.ServiceError`).
    #[error(transparent)]
    ServiceError(#[from] tonic::Status),

    /// Generic wrapper for other errors.
    ///
    /// Becomes a JS `Error`.
    #[error(transparent)]
    Other(#[from] AnyhowError),

    /// Wrapper for errors that have already been _thrown_ from the JS context.  This requires
    /// special handling because while a JavaScript thread is throwing, its context cannot be used;
    /// doing so would result in a panic.  That notably means that we cannot use `cx.throw_error` to
    /// throw a different error at that point.
    ///
    /// Though this case is technically unavoidable due to most Neon's APIs returning either
    /// `NeonResult` or `JsResult`, and is better than just panicking from `.unwrap()` those, code
    /// should strive as much as possible to detect potential errors in a way that will not result
    /// in a JS exception being thrown.
    ///
    /// Unfortunately, it is not possible to extract the message or the type of the thrown error, so
    /// this error will always have a message of "Error thrown from JS".
    #[error("Error thrown from JS")]
    JsThrow { thrown: RefCell<Option<ThrowBox>> },
}

// Append Field Context ////////////////////////////////////////////////////////////////////////////

pub trait AppendFieldContext {
    /// Add context to a `TypeError` by prepending a field name.
    ///
    /// This is useful when converting from JS to Rust types, where the field name is known and can
    /// be added to the error message to guide the user in the right direction. It is expected that
    /// field name context will be provided on `BridgeResult` _after_ the conversion that may fail,
    /// while propagating the error through the `BridgeResult` chain, hence the fact that fields
    /// are _prepended_, not _appended_.
    #[must_use]
    fn field(self, prepend_field: &str) -> Self;
}

impl<T> AppendFieldContext for BridgeResult<T> {
    fn field(self, prepend_field: &str) -> Self {
        match self {
            Ok(value) => Ok(value),
            Err(e) => Err(e.field(prepend_field)),
        }
    }
}

impl AppendFieldContext for BridgeError {
    fn field(self, prepend_field: &str) -> Self {
        match self {
            Self::TypeError {
                field: previous_field,
                message,
            } => Self::TypeError {
                field: match previous_field {
                    Some(previous_field) => Some(format!("{prepend_field}.{previous_field}")),
                    None => Some(prepend_field.to_string()),
                },
                message,
            },
            Self::InvalidVariant { enum_name, variant } => Self::TypeError {
                field: Some(prepend_field.to_string()),
                message: format!("Invalid variant '{variant}' for enum {enum_name}"),
            },
            e => e,
        }
    }
}

// Conversions from other errors ///////////////////////////////////////////////////////////////////

impl<F: Value, T: Value> From<DowncastError<F, T>> for BridgeError {
    fn from(error: DowncastError<F, T>) -> Self {
        Self::TypeError {
            field: None,
            message: error.to_string(),
        }
    }
}

// Conversion to/from Throw ////////////////////////////////////////////////////////////////////////

impl From<Throw> for BridgeError {
    fn from(throw: Throw) -> Self {
        Self::JsThrow {
            thrown: RefCell::new(Some(ThrowBox(throw))),
        }
    }
}

pub trait IntoThrow {
    type Output;
    fn into_throw<'a, C: Context<'a>>(self, cx: &mut C) -> NeonResult<Self::Output>
    where
        Self: Sized;
}

impl<T> IntoThrow for BridgeResult<T> {
    type Output = T;

    fn into_throw<'cx, C: Context<'cx>>(self, cx: &mut C) -> NeonResult<Self::Output> {
        match self {
            Ok(value) => Ok(value),
            Err(err) => err.into_throw::<C, Self::Output>(cx),
        }
    }
}

impl BridgeError {
    fn into_throw<'cx, C: Context<'cx>, T>(self, cx: &mut C) -> NeonResult<T> {
        match self {
            Self::TypeError { .. } | Self::InvalidVariant { .. } => {
                cx.throw_type_error(self.to_string())
            }

            Self::ServiceError(err) => {
                let err = err.try_into_js(cx)?;
                cx.throw(err)
            }

            Self::TransportError(..) => throw_custom_error(cx, TRANSPORT_ERROR, self.to_string()),

            Self::IllegalStateStillInUse { .. } | Self::IllegalStateAlreadyClosed { .. } => {
                throw_custom_error(cx, ILLEGAL_STATE_ERROR, self.to_string())
            }

            Self::UnexpectedError(..) => throw_custom_error(cx, UNEXPECTED_ERROR, self.to_string()),

            Self::WorkerShutdown => throw_custom_error(cx, SHUTDOWN_ERROR, self.to_string()),

            Self::Other(e) => {
                if let Some(thrown) = underlying_js_throw_error(&e) {
                    warn!("Error thrown from JavaScript side: {e:?}");
                    Err(thrown)
                } else {
                    cx.throw_error(format!("{e:#}"))
                }
            }

            Self::JsThrow { thrown } => Err(thrown.take().expect("Throw already consumed").0),
        }
    }
}

/// Extracts a `Throw` from an `AnyhowError` chain.
fn underlying_js_throw_error(error: &AnyhowError) -> Option<Throw> {
    for cause in error.chain() {
        if let Some(BridgeError::JsThrow { thrown }) = cause.downcast_ref::<BridgeError>() {
            return Some(thrown.take().expect("Throw already consumed").0);
        }
    }
    None
}

/// A wrapper around a `Throw` that implements `Send` and `Sync`. This is necessary because we need
/// `BridgeError` to be `Send`, but `BridgeError::JsThrow` contains a `Throw`, which isn't `Send`.
///
/// We however know for sure that `BridgeError::JsThrow` will never be sent across threads, because
/// a `Throw`'s lifetime is attached to that of the JS `Context`, which itself isn't `Send`.
#[repr(transparent)]
pub struct ThrowBox(Throw);

/// SAFETY: We know for sure that this type will never actually be sent across threads.
#[allow(clippy::non_send_fields_in_send_ty)]
unsafe impl Send for ThrowBox {}

/// SAFETY: We know for sure that this type will never actually be sent across threads.
unsafe impl Sync for ThrowBox {}

impl std::fmt::Debug for ThrowBox {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

// Message formatting utilities ////////////////////////////////////////////////////////////////////

fn field_prefix(field: Option<&String>) -> String {
    match field {
        Some(field) => format!("{field}: "),
        None => String::new(),
    }
}

fn details_suffix(details: Option<&String>) -> String {
    match details {
        Some(details) => format!(": {details}"),
        None => String::new(),
    }
}

// Custom JavaScript errors ////////////////////////////////////////////////////////////////////////

/// Signals that a requested operation can't be completed because it is illegal given the
/// current state of the object; e.g. trying to use a resource after it has been closed.
const ILLEGAL_STATE_ERROR: &str = "IllegalStateError";

/// Something unexpected happened, considered fatal
const UNEXPECTED_ERROR: &str = "UnexpectedError";

/// An unhandled error while communicating with the server, considered fatal
const TRANSPORT_ERROR: &str = "TransportError";

/// Thrown after shutdown was requested as a response to a poll function, JS should stop polling
const SHUTDOWN_ERROR: &str = "ShutdownError";

/// Instantiate and throw a custom JS Error object with a given name and message.
///
/// Note that this do not actually instantiate the proper JS classes, as those
/// are not accessible from here (i.e. they are not exposed as globals). Instead,
/// we simply override the `name` property of the error object; the bridge adds
/// a JS-side wrapper around native calls that will look at the `name` property
/// of every thrown errors, and replace them by proper instances of the custom
/// Error classes if appropriate. Refer to `core-bridge/ts/errors.ts`.
fn throw_custom_error<'cx, C: Context<'cx>, S: AsRef<str>, T>(
    cx: &mut C,
    name: &str,
    message: S,
) -> NeonResult<T> {
    let error = cx.error(message)?;
    let name = cx.string(name);
    error.set(cx, "name", name)?;

    cx.throw(error)
}
