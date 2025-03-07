use neon::prelude::*;

pub trait JavaScriptContextCustomErrors<'a>: Context<'a> {
    fn throw_illegal_state_error<S: AsRef<str>, T>(&mut self, message: S) -> NeonResult<T>;

    fn throw_unexpected_error<S: AsRef<str>, T>(&mut self, message: S) -> NeonResult<T>;

    fn throw_transport_error<S: AsRef<str>, T>(&mut self, message: S) -> NeonResult<T>;

    fn throw_shutdown_error<S: AsRef<str>, T>(&mut self, message: S) -> NeonResult<T>;

    /// Used in different parts of the project to signal that something unexpected has happened
    fn illegal_state_error<S: AsRef<str>>(&mut self, message: S) -> JsResult<'a, JsError>;

    /// Something unexpected happened, considered fatal
    fn unexpected_error<S: AsRef<str>>(&mut self, message: S) -> JsResult<'a, JsError>;

    /// An unhandled error while communicating with the server, considered fatal
    fn transport_error<S: AsRef<str>>(&mut self, message: S) -> JsResult<'a, JsError>;

    /// Thrown after shutdown was requested as a response to a poll function, JS should stop polling
    /// once this error is encountered
    fn shutdown_error<S: AsRef<str>>(&mut self, message: S) -> JsResult<'a, JsError>;

    fn make_named_error_from_string<S: AsRef<str>>(
        &mut self,
        name: &str,
        message: S,
    ) -> JsResult<'a, JsError>;
}

impl<'a, C: Context<'a>> JavaScriptContextCustomErrors<'a> for C {
    fn throw_illegal_state_error<S: AsRef<str>, T>(&mut self, msg: S) -> NeonResult<T> {
        let err = self.illegal_state_error(msg)?;
        self.throw(err)
    }

    fn throw_unexpected_error<S: AsRef<str>, T>(&mut self, msg: S) -> NeonResult<T> {
        let err = self.unexpected_error(msg)?;
        self.throw(err)
    }

    fn throw_transport_error<S: AsRef<str>, T>(&mut self, msg: S) -> NeonResult<T> {
        let err = self.transport_error(msg)?;
        self.throw(err)
    }

    fn throw_shutdown_error<S: AsRef<str>, T>(&mut self, msg: S) -> NeonResult<T> {
        let err = self.shutdown_error(msg)?;
        self.throw(err)
    }

    fn illegal_state_error<S: AsRef<str>>(&mut self, msg: S) -> JsResult<'a, JsError> {
        self.make_named_error_from_string("IllegalStateError", msg)
    }

    fn unexpected_error<S: AsRef<str>>(&mut self, msg: S) -> JsResult<'a, JsError> {
        self.make_named_error_from_string("UnexpectedError", msg)
    }

    fn transport_error<S: AsRef<str>>(&mut self, msg: S) -> JsResult<'a, JsError> {
        self.make_named_error_from_string("TransportError", msg)
    }

    fn shutdown_error<S: AsRef<str>>(&mut self, msg: S) -> JsResult<'a, JsError> {
        self.make_named_error_from_string("ShutdownError", msg)
    }

    /// Note that this function returns Ok(error), not Err(error) as one might expect.
    /// That's in line with Neon's `cx.error()` and `JsError::type_error()` functions,
    /// and makes sense if you consider that the role of these functions is to _create_
    /// an error object, which is indeed successful.
    ///
    /// To actually throw the error, you would generally do something like `cx.throw(error)?`.
    fn make_named_error_from_string<S: AsRef<str>>(
        &mut self,
        name: &str,
        message: S,
    ) -> JsResult<'a, JsError> {
        let error = self.error(message).unwrap();
        let name = self.string(name);
        error.set(self, "name", name)?;

        Ok(error)
    }

    // pub fn make_named_error_from_error<'a, C, E>(
    //     cx: &mut C,
    //     name: &str,
    //     err: E,
    // ) -> JsResult<'a, JsError>
    // where
    //     C: Context<'a>,
    //     E: std::error::Error,
    // {
    //     make_named_error_from_string(cx, name, format!("{:?}", err))
    // }
}
