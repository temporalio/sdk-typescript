use neon::prelude::*;

/// An unhandled error while communicating with the server, considered fatal
pub static TRANSPORT_ERROR: CustomError = CustomError { name: "TransportError" };
/// Thrown after shutdown was requested as a response to a poll function, JS should stop polling
/// once this error is encountered
pub static SHUTDOWN_ERROR: CustomError = CustomError { name: "ShutdownError" };
/// Something unexpected happened, considered fatal
pub static UNEXPECTED_ERROR: CustomError = CustomError { name: "UnexpectedError" };
/// Used in different parts of the project to signal that something unexpected has happened
pub static ILLEGAL_STATE_ERROR: CustomError = CustomError { name: "IllegalStateError" };

/// This is one of the ways to implement custom errors in neon.
/// Taken from the answer in GitHub issues: https://github.com/neon-bindings/neon/issues/714
pub trait CustomError {
    fn construct<'a, C>(&self, cx: &mut C, args: Vec<Handle<JsValue>>) -> JsResult<'a, JsObject>
    where
        C: Context<'a>;

    fn construct_from_string<'a, C>(&self, cx: &mut C, message: impl Into<String>) -> JsResult<'a, JsObject>
    where
        C: Context<'a>;

    fn construct_from_error<'a, C, E>(&self, cx: &mut C, err: E) -> JsResult<'a, JsObject>
    where
        C: Context<'a>,
        E: std::error::Error;
}

impl CustomError {
    pub fn construct_from_string<'a, C>(&self, cx: &mut C, message: impl Into<String>) -> JsResult<'a, JsError>
    where
        C: Context<'a>,
    {
        let error = cx.error(message.into()).unwrap();
        let name = cx.string(self.name);
        error.set(cx, "name", name)?;

        Ok(error)
    }

    pub fn construct_from_error<'a, C, E>(&self, cx: &mut C, err: E) -> JsResult<'a, JsError>
    where
        C: Context<'a>,
        E: std::error::Error,
    {
        self.construct_from_string(cx, format!("{:?}", err))
    }
}
