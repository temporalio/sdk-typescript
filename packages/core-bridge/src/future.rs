use std::{pin::Pin, sync::Arc};

use neon::{prelude::Context, result::JsResult, types::JsPromise};
use temporal_sdk_core::CoreRuntime;

use crate::{
    helpers::{BridgeError, BridgeResult, IntoThrow, TryIntoJs},
    runtime::RuntimeHandle,
};

#[macro_export]
macro_rules! enter_sync {
    ($runtime:expr) => {
        if let Some(subscriber) = $runtime.core_runtime.telemetry().trace_subscriber() {
            temporal_sdk_core::telemetry::set_trace_subscriber_for_current_thread(subscriber);
        }
        let _guard = $runtime.core_runtime.tokio_handle().enter();
    };
}

impl RuntimeHandle {
    pub fn future_to_promise<'a, F, R>(&self, future: F) -> BridgeResult<BridgeFuture<R>>
    where
        F: Future<Output = Result<R, BridgeError>> + Send + 'static,
        R: TryIntoJs + Send + 'static,
    {
        Ok(BridgeFuture {
            future: Box::pin(future),
            core_runtime: self.core_runtime.clone(),
        })
    }
}

////////////////////////////////////////////////////////////////////////////////////////////////////

pub struct BridgeFuture<R: TryIntoJs + Send + 'static> {
    future: Pin<Box<dyn Future<Output = Result<R, BridgeError>> + Send + 'static>>,
    core_runtime: Arc<CoreRuntime>,
}

impl<R: TryIntoJs + Send + 'static> TryIntoJs for BridgeFuture<R> {
    type Output = JsPromise;

    fn try_into_js<'a>(self, cx: &mut impl Context<'a>) -> JsResult<'a, JsPromise> {
        let cx_channel = cx.channel();
        let (deferred, promise) = cx.promise();

        self.core_runtime.tokio_handle().spawn(async move {
            let result = self.future.await;
            let send_result = deferred.try_settle_with(&cx_channel, move |mut cx| {
                result.into_throw(&mut cx)?.try_into_js(&mut cx)
            });
            if let Err(err) = send_result {
                eprint!("Failed to complete JS Promise: {:?}", err);
            }
        });

        Ok(promise)
    }
}
