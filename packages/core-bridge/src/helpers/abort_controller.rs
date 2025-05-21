use std::sync::{
    Arc, OnceLock,
    atomic::{AtomicU8, Ordering, fence},
};

use neon::{
    handle::{Handle, Root},
    object::Object,
    prelude::{Context, JsResult},
    types::{JsFunction, JsObject, JsValue},
};

use super::{BridgeResult, JsCallback, TryIntoJs, errors::IntoThrow as _};

pub type JsAbortController = JsObject;
pub type JsAbortSignal = JsValue;

/// An object that models a JavaScript `AbortController`, and its corresponding `AbortSignal`,
/// allowing the Rust side to fire that signal if/when needed, e.g. when dropped from the Rust side.
///
/// The JS counterpart object is lazily instantiated when the signal gets converted to JS (through
/// the `TryIntoJs` trait); this ensures that the Rust side can be created without a JS `Context`.
pub struct AbortController {
    inner: Arc<AbortControllerInner>,
    drop_abort_reason: String,
}

/// An object that models the signal of a JavaScript `AbortController`.
pub struct AbortSignal {
    inner: Arc<AbortControllerInner>,
}

/// The inner state of an `AbortController`, shared between the Rust and JS sides.
struct AbortControllerInner {
    // The fact that we require a `Context` to initialize the JS counterpart means that we are running
    // on the Node's thread, which guarantees that there can't be multiple threads calling into that
    // function concurrently; that should in theory aleviate the need to use a lock on `js_counterpart`.
    //
    // It is however possible for the rust-side controller to get aborted from a non-Node thread
    // while the JS-side controller is being created on the Node thread, in which case we don't
    // want the Rust-side thread to get blocked for the JS-side to complete instantiation.
    //
    // By modelling the "JS initialization" and "is aborted" states as two distinct independant
    // structures, we ensure that we're never blocking execution of either thread. This however
    // means that either step may happen before the other, so we need to be careful not to miss
    // sending the abort signal. The good news is that nothing bad will happen if we call the JS
    // abort callback multiple times.
    js_counterpart: OnceLock<AbortControllerJsCounterpart>,
    aborted: OnceLock<String>,

    state: AtomicU8,
}

struct AbortControllerJsCounterpart {
    controller: Root<JsObject>,
    abort: JsCallback<(String,), ()>,
}

const STATE_UNINITIALIZED: u8 = 0;
const STATE_ARMED: u8 = 1 << 0;
const STATE_ABORTED: u8 = 1 << 1;
const STATE_DISARMED: u8 = STATE_ARMED | STATE_ABORTED;

impl AbortController {
    /// Create a new `AbortController`.
    ///
    /// The `drop_abort_reason` string will be used as the reason for the abort
    /// if the controller is dropped from the Rust side.
    #[must_use]
    pub fn new(drop_abort_reason: String) -> Self {
        let inner = AbortControllerInner {
            js_counterpart: OnceLock::new(),
            aborted: OnceLock::new(),
            state: AtomicU8::new(STATE_UNINITIALIZED),
        };
        let inner = Arc::new(inner);
        Self {
            inner,
            drop_abort_reason,
        }
    }

    /// Get an associated `AbortSignal` object for this controller. This method can
    /// be called at any time (i.e. even after the controller has been cancelled),
    /// any number of times (i.e. to pass a same signal to multiple JS functions),
    /// and from any thread.
    #[must_use]
    pub fn get_signal(&self) -> AbortSignal {
        AbortSignal {
            inner: self.inner.clone(),
        }
    }

    /// Abort the controller, causing the JS side `signal` to fire.
    ///
    /// This method can be called at any time (i.e. even before the controller has been armed,
    /// or after it has been disarmed), and from any thread.
    pub fn abort(&self, reason: impl Into<String>) {
        self.inner.abort(reason);
    }

    /// Disarm the controller, so that it can no longer be aborted.
    ///
    /// Once a controller has been disarmed, it's abort status will not change anymore. It is
    /// recommended to call this method once it is known that the signal is no longer needed
    /// on the JS side, e.g. when the called JS function has returned, as this will prevent the
    /// overhead of implicit abortion when the controller is dropped.
    pub fn disarm(&self) {
        self.inner.disarm();
    }
}

impl Drop for AbortController {
    fn drop(&mut self) {
        self.abort(self.drop_abort_reason.clone());
    }
}

////////////////////////////////////////////////////////////////////////////////////////////////////

impl TryIntoJs for AbortSignal {
    type Output = JsAbortSignal;
    fn try_into_js<'cx>(self, cx: &mut impl Context<'cx>) -> JsResult<'cx, JsAbortSignal> {
        let controller = self.inner.get_or_init_controller(cx).into_throw(cx)?;
        controller.get(cx, "signal")
    }
}

impl AbortControllerInner {
    /// Create the JS `AbortController` if it hasn't been created yet.
    /// Returns a reference to the signal object that can be passed to JS.
    fn get_or_init_controller<'cx, C: Context<'cx>>(
        &self,
        cx: &mut C,
    ) -> BridgeResult<Handle<'cx, JsAbortController>> {
        if let Some(js_counterpart) = self.js_counterpart.get() {
            // Already initialized, return the controller
            return Ok(js_counterpart.controller.to_inner(cx).upcast());
        }

        // Not initialized yet, create the JS AbortController
        let global = cx.global_object();
        let abort_controller_class = global.get::<JsFunction, _, _>(cx, "AbortController")?;
        let js_controller = abort_controller_class.construct(cx, [])?;

        let abort_fn = js_controller.get::<JsFunction, _, _>(cx, "abort")?;
        let abort_cb = JsCallback::new(cx, abort_fn, Some(js_controller));

        let js_counterpart = AbortControllerJsCounterpart {
            controller: js_controller.root(cx),
            abort: abort_cb,
        };

        let controller = match self.js_counterpart.set(js_counterpart) {
            Ok(()) => {
                // Ordering: Write to `state` implies previous write to `js_counterpart` is visible to other threads
                if self.state.fetch_or(STATE_ARMED, Ordering::Release) == STATE_ABORTED {
                    // Ordering: Previous concurrent write to `aborted` must be visible at this point
                    fence(Ordering::Acquire);

                    // The controller was aborted before it was armed; immediately call the abort callback

                    // Fire and forget
                    let _ = self
                        .js_counterpart
                        .get()
                        .unwrap()
                        .abort
                        .call(cx, (self.aborted.get().unwrap().clone(),));
                }
                js_controller
            }
            Err(js_counterpart) => js_counterpart.controller.to_inner(cx).upcast(),
        };

        Ok(controller)
    }

    /// Immediately abort the `AbortController`, causing the JS side `signal` to fire.
    fn abort(&self, reason: impl Into<String>) {
        let reason = reason.into();
        if self.aborted.set(reason.clone()) == Ok(()) {
            // If we haven't created the JS AbortController yet, there's nothing to abort
            // Ordering: Write to `state` implies previous write to `aborted` is visible to other threads
            if self.state.fetch_or(STATE_ABORTED, Ordering::Release) == STATE_ARMED {
                // Ordering: Previous concurrent write to `js_counterpart` must be visible at this point
                fence(Ordering::Acquire);

                // Fire and forget
                let _ = self
                    .js_counterpart
                    .get()
                    .unwrap()
                    .abort
                    .call_on_js_thread((reason,));
            }
        }
    }

    fn disarm(&self) {
        // Ordering: this requires no dependency on any other state
        self.state.store(STATE_DISARMED, Ordering::Relaxed);
    }
}
