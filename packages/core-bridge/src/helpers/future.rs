use std::pin::Pin;

use neon::{prelude::Context, result::JsResult, types::JsPromise};
use tracing::warn;

use crate::helpers::{BridgeError, IntoThrow, TryIntoJs};

pub struct BridgeFuture<R: TryIntoJs + Send + 'static> {
    future: Pin<Box<dyn Future<Output = Result<R, BridgeError>> + Send + 'static>>,
    tokio_handle: tokio::runtime::Handle,
}

impl<R: TryIntoJs + Send + 'static> BridgeFuture<R> {
    #[must_use]
    pub fn new(
        future: Pin<Box<dyn Future<Output = Result<R, BridgeError>> + Send + 'static>>,
    ) -> Self {
        Self {
            future,
            tokio_handle: tokio::runtime::Handle::current(),
        }
    }
}

impl<R: TryIntoJs + Send + 'static> TryIntoJs for BridgeFuture<R> {
    type Output = JsPromise;

    fn try_into_js<'a>(self, cx: &mut impl Context<'a>) -> JsResult<'a, JsPromise> {
        let cx_channel = cx.channel();
        let (deferred, promise) = cx.promise();

        self.tokio_handle.spawn(async move {
            let result = self.future.await;
            let send_result = deferred.try_settle_with(&cx_channel, move |mut cx| {
                result.into_throw(&mut cx)?.try_into_js(&mut cx)
            });
            if let Err(err) = send_result {
                warn!("Failed to complete JS Promise: {err:?}");
            }
        });

        Ok(promise)
    }
}
