use std::sync::{Arc, OnceLock};

use neon::{
    handle::{Handle, Root},
    object::Object,
    prelude::{Context, JsResult},
    types::{JsFunction, JsObject, JsValue},
};

use super::{BridgeResult, JsCallback, TryIntoJs, errors::IntoThrow as _};

pub type JsAbortSignal = JsValue;

/// An object that serializes as an AbortSignal on the JS side, allowing the Rust
/// side to fire that signal if/when needed, e.g. when dropped from the Rust side.
///
/// Note that the JS side `AbortController` object is created lazily when converting to JS,
/// so the Rust side can be instantiated without the JS execution lock.
pub struct AbortController {
    inner: Arc<AbortControllerInner>,
}

impl AbortController {
    /// Create a new AbortController and AbortSignal pair, with the given reason string.
    pub fn new() -> (AbortController, AbortSignal) {
        let inner = AbortControllerInner {
            js_counterpart: OnceLock::new(),
            aborted: OnceLock::new(),
        };
        let inner = Arc::new(inner);
        (
            AbortController {
                inner: inner.clone(),
            },
            AbortSignal {
                inner: inner.clone(),
            },
        )
    }

    pub fn abort(&self, reason: impl Into<String>) -> () {
        self.inner.abort(reason);
    }
}

impl Drop for AbortController {
    fn drop(&mut self) {
        self.abort("Cancelled");
    }
}

/// An object that serializes as an AbortSignal on the JS side, allowing the Rust.
pub struct AbortSignal {
    inner: Arc<AbortControllerInner>,
}

impl TryIntoJs for AbortSignal {
    type Output = JsAbortSignal;

    fn try_into_js<'cx>(self, cx: &mut impl Context<'cx>) -> JsResult<'cx, JsAbortSignal> {
        let signal = self.inner.ensure_js_initialized(cx).into_throw(cx)?;
        Ok(signal)
    }
}

/// The inner state of an AbortController, shared between the Rust and JS sides.
struct AbortControllerInner {
    js_counterpart: OnceLock<Arc<AbortControllerJsCounterpart>>,
    aborted: OnceLock<String>,
}

struct AbortControllerJsCounterpart {
    signal: Root<JsObject>,
    abort: JsCallback<(String,), ()>,
}

impl AbortControllerInner {
    /// Create the JS AbortController if it hasn't been created yet.
    /// Returns a reference to the signal object that can be passed to JS.
    fn ensure_js_initialized<'cx, C: Context<'cx>>(
        &self,
        cx: &mut C,
    ) -> BridgeResult<Handle<'cx, JsValue>> {
        // It is however possible that the rust-side controller might get aborted from a non-Node
        // thread while the JS-side controller is being created on the Node thread, in which case
        // we don't want the Rust-side thread to get blocked for the JS-side to complete
        // instantiation. Hence, we
        //
        // The fact that we require a Context here means that we are running on the Node's thread,
        // which guarantees that there can't be multiple threads calling into this function
        // concurrently; it threfore makes no difference from the JS thread either we acquire the
        // lock here or not.

        if let Some(js_counterpart) = self.js_counterpart.get() {
            // Already initialized, return the signal
            return Ok(js_counterpart.signal.to_inner(cx).upcast());
        }

        // Not initialized yet, create the JS AbortController
        let global = cx.global_object();
        let abort_controller_class = global.get::<JsFunction, _, _>(cx, "AbortController")?;

        let abort_controller = abort_controller_class.construct(cx, [])?;
        let signal = abort_controller.get::<JsObject, _, _>(cx, "signal")?;
        let abort_fn = abort_controller.get::<JsFunction, _, _>(cx, "abort")?;

        let abort_cb = JsCallback::new(cx, abort_fn, Some(abort_controller));

        let js_counterpart = Arc::new(AbortControllerJsCounterpart {
            signal: signal.root(cx),
            abort: abort_cb,
        });

        let js_counterpart = match self.js_counterpart.set(js_counterpart.clone()) {
            Ok(()) => {
                // If the Rust controller has already been aborted, call the JS abort callback now
                // VALIDATE: Do we need a memory barrier here to ensure that js_counterpart and aborted are coherent?
                //           I assume that the get() call ensures visibility of the js_counterpart
                if let Some(aborted) = self.aborted.get() {
                    // Fire and forget
                    let _ = js_counterpart.abort.call_on_js_thread((aborted.clone(),));
                }
                js_counterpart
            }
            Err(js_counterpart) => js_counterpart,
        };

        Ok(js_counterpart.signal.to_inner(cx).upcast())
    }

    /// Immediately abort the `AbortController`, causing the JS side `signal` to fire.
    fn abort(&self, reason: impl Into<String>) -> () {
        let reason = reason.into();
        if let Ok(()) = self.aborted.set(reason.clone()) {
            // If we haven't created the JS AbortController yet, there's nothing to abort
            // VALIDATE: Do we need a memory barrier here to ensure that js_counterpart and aborted are coherent?
            if let Some(js_counterpart) = self.js_counterpart.get() {
                // Fire and forget
                let _ = js_counterpart.abort.call_on_js_thread((reason.clone(),));
            }
        }
    }
}
