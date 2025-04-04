use std::cell::RefCell;

use anyhow::Error as AnyhowError;
use neon::{handle::DowncastError, prelude::*, result::Throw};

/// A specialized Result type for errors that can be rethrown as a JS error.
pub type BridgeResult<T> = Result<T, BridgeError>;

/// Errors that can be rethrown by the Bridge as JS errors.
#[derive(Debug, thiserror::Error)]
pub enum BridgeError {
    /// Error when converting from JS to Rust types.
    ///
    /// Use `BridgeResult::field` to prepend a field name to the error.
    #[error("{}", match field {
        Some(field) => format!("{}: {}", field, message),
        None => message.clone(),
    })]
    TypeError {
        field: Option<String>,
        message: String,
    },

    /// Error when a transport error occurs.
    #[error("{0}")]
    TransportError(String),

    /// Error when an enum variant is invalid
    #[error("Invalid variant '{variant}' for enum {enum_name}")]
    InvalidVariant { enum_name: String, variant: String },

    #[error("IllegalState: {what} still in use")]
    IllegalStateStillInUse {
        what: &'static str,
        details: Option<String>,
    },

    #[error("IllegalState: {what} already closed")]
    IllegalStateAlreadyClosed { what: &'static str },

    #[error("Unexpected error: {0}")]
    UnexpectedError(String),

    /// Error when a worker is shutdown
    #[error("Worker has been shutdown")]
    WorkerShutdown,

    /// Generic wrapper for other errors
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
    fn field(self, prepend_field: &str) -> Self;
}

impl<T> AppendFieldContext for BridgeResult<T> {
    fn field(self, prepend_field: &str) -> BridgeResult<T> {
        match self {
            Ok(value) => Ok(value),
            Err(e) => Err(e.field(prepend_field)),
        }
    }
}

impl AppendFieldContext for BridgeError {
    fn field(self, prepend_field: &str) -> BridgeError {
        println!("AppendFieldContext: {:?}, {}", self, prepend_field);
        match self {
            BridgeError::TypeError {
                field: previous_field,
                message,
            } => BridgeError::TypeError {
                field: match previous_field {
                    Some(previous_field) => Some(format!("{}.{}", prepend_field, previous_field)),
                    None => Some(prepend_field.to_string()),
                },
                message,
            },
            BridgeError::InvalidVariant { enum_name, variant } => BridgeError::TypeError {
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
        println!(
            "DowncastError: {:?}, {:?}, {:?}",
            error,
            F::name(),
            T::name()
        );
        println!("{:?}", anyhow::anyhow!("downcast error"));
        BridgeError::TypeError {
            field: None,
            message: error.to_string(),
        }
    }
}

// Conversion to/from Throw ////////////////////////////////////////////////////////////////////////

impl From<Throw> for BridgeError {
    fn from(throw: Throw) -> Self {
        BridgeError::JsThrow {
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

            Err(BridgeError::TypeError { field, message }) => {
                let message = match field {
                    Some(field) => format!("{}: {}", field, message),
                    None => message,
                };
                cx.throw_type_error(message)
            }

            Err(BridgeError::InvalidVariant { enum_name, variant }) => {
                cx.throw_type_error(format!("Invalid variant '{variant}' for enum {enum_name}"))
            }

            Err(BridgeError::TransportError(message)) => cx.throw_transport_error(message),

            Err(BridgeError::IllegalStateStillInUse { what, details }) => {
                let message = match details {
                    Some(details) => format!("{}: {}", what, details),
                    None => what.to_string(),
                };
                cx.throw_illegal_state_error(message)
            }

            Err(BridgeError::IllegalStateAlreadyClosed { what }) => {
                cx.throw_illegal_state_error(format!("{} already closed", what))
            }

            Err(BridgeError::UnexpectedError(message)) => cx.throw_unexpected_error(message),

            Err(BridgeError::WorkerShutdown) => cx.throw_shutdown_error("Worker has been shutdown"),

            Err(BridgeError::Other(e)) => {
                if let Some(thrown) = underlying_js_throw_error(&e) {
                    // FIXME: Send to logger
                    eprintln!("Error thrown from JavaScript side: {:?}", e);
                    Err(thrown)
                } else {
                    cx.throw_error(format!("{:#}", e))
                }
            }

            Err(BridgeError::JsThrow { thrown }) => {
                Err(thrown.take().expect("Throw already consumed").0)
            }
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
unsafe impl Send for ThrowBox {}

/// SAFETY: We know for sure that this type will never actually be sent across threads.
unsafe impl Sync for ThrowBox {}

impl std::fmt::Debug for ThrowBox {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

// Custom JavaScript errors ////////////////////////////////////////////////////////////////////////

pub trait CustomJavaScriptErrors<'a>: Context<'a> {
    /// Used in different parts of the project to signal that something unexpected has happened
    fn throw_illegal_state_error<S: AsRef<str>, T>(&mut self, message: S) -> NeonResult<T>;

    /// Something unexpected happened, considered fatal
    fn throw_unexpected_error<S: AsRef<str>, T>(&mut self, message: S) -> NeonResult<T>;

    /// An unhandled error while communicating with the server, considered fatal
    fn throw_transport_error<S: AsRef<str>, T>(&mut self, message: S) -> NeonResult<T>;

    /// Thrown after shutdown was requested as a response to a poll function, JS should stop polling
    /// once this error is encountered
    fn throw_shutdown_error<S: AsRef<str>, T>(&mut self, message: S) -> NeonResult<T>;
}

impl<'a, C: Context<'a>> CustomJavaScriptErrors<'a> for C {
    fn throw_illegal_state_error<S: AsRef<str>, T>(&mut self, msg: S) -> NeonResult<T> {
        let err = make_named_error_from_string(self, "IllegalStateError", msg)?;
        self.throw(err)
    }

    fn throw_unexpected_error<S: AsRef<str>, T>(&mut self, msg: S) -> NeonResult<T> {
        let err = make_named_error_from_string(self, "UnexpectedError", msg)?;
        self.throw(err)
    }

    fn throw_transport_error<S: AsRef<str>, T>(&mut self, msg: S) -> NeonResult<T> {
        let err = make_named_error_from_string(self, "TransportError", msg)?;
        self.throw(err)
    }

    fn throw_shutdown_error<S: AsRef<str>, T>(&mut self, msg: S) -> NeonResult<T> {
        let err = make_named_error_from_string(self, "ShutdownError", msg)?;
        self.throw(err)
    }
}

/// Note that this function returns Ok(error), not Err(error) as one might expect.
/// That's in line with Neon's `cx.error()` and `JsError::type_error()` functions,
/// and makes sense if you consider that the role of these functions is to _create_
/// an error object, which is indeed successful.
///
/// To actually throw the error, you would generally do something like `cx.throw(error)?`.
fn make_named_error_from_string<'a, C: Context<'a>, S: AsRef<str>>(
    cx: &mut C,
    name: &str,
    message: S,
) -> JsResult<'a, JsError> {
    let error = cx.error(message).unwrap();
    let name = cx.string(name);
    error.set(cx, "name", name)?;

    Ok(error)
}
