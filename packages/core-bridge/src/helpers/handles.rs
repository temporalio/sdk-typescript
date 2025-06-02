use std::{
    any,
    cell::{Ref, RefCell},
    rc::Rc,
};

use neon::{prelude::*, types::JsBox};
use parking_lot::Mutex;

use super::{BridgeError, BridgeResult, IntoThrow, TryFromJs, TryIntoJs};

/// Opaque Handles are native structures that are sent into the JS side but without exposing
/// their internal structure; i.e. they are only meant to be passed back to the Rust side
/// on appropriate API calls.
///
/// Due to very different ownership models and usage patterns, and to avoid unnecessary
/// complexity, Opaque Handles are split into two variants:
///
/// - `OpaqueOutboundHandle` - for sending an opaque handle that was just created by the Rust
///                            side to the JS side (e.g. as the return value of an API call).
/// - `OpaqueInboundHandle` - for accepting an opaque handle sent from the JS side to the Rust
///                           side (e.g. as an argument to an API call).
///
/// **Internals**
/// `OpaqueOutboundHandle` owns the inner object directly (i.e. without Neon's `Handle<JsBox<…>>`),
/// until it is sent to the JS side in `try_into_js`. From that point on, the inner object is
/// wrapped in a `Handle<JsBox<Rc<FinalizeWrapper<RefCell<...>>>>`, which belongs to the JS thread
/// on which it is sent to the JS side in `try_into_js`. From that point on, the inner object is
/// wrapped in a `Handle<JsBox<Rc<FinalizeWrapper<RefCell<...>>>>`, which belongs to the JS thread
/// on which it was sent. The inner object will no longer be sent across threads until the handle
/// is later disolved (see below).
///
/// `OpaqueInboundHandle` receives a reference to a `Handle<JsBox<...>>` struct from the JS side,
/// and from that, holds a temporary shared ownership of the `RefCell<...>` through the `Rc`.
/// The `OpaqueInboundHandle` can be disolved by any of these three means:
///
///  1. `OpaqueInboundHandle::take` or `OpaqueInboundHandle::try_take` explicitly; this can be
///     done for example to implement an explicit destructor for the target object, and has the
///     advantage that it allows returning a `Promise` to the JS side to await the completion
///     of the destructor.
///  2. The corresponding JS side object gets GC'ed, resulting in Neon calling `Finalize` on the
///     `JsBox`, which propagates down to the Wrapper; the `OpaqueInboundHandle` intercepts that
///     event and make it a call to `FinalizeMut` on the inner object IIF the handle has not been
///     taken already. This executes on the JS thread, but it is not possible to return a `Promise`
///     or anything else back to the JS side.
///  3. The `FinalizeWrapper` is dropped at any point, which should in theory be rare aside from
///     following the previous two scenarios. It may however happen if the `OpaqueOutboundHandle`
///     is dropped before is has been sent to JS. It has also been observed in practice in some
///     degenerate scenarios involving panics or JS threads exiting uncleanly. The `FinalizeWrapper`
///     intercepts these cases and call `FinalizeMut` on the inner object IIF the object has not
///     been taken already. This may happen on either the JS thread, or the Rust thread that created
///     the `OpaqueOutboundHandle`.
///
// FIXME(JWH): At this point, I'm now seeing how it would be possible to merge Inbound and Outbound
//             handles into a single object. To be revisited at a later point.
pub struct OpaqueOutboundHandle<T: MutableFinalize + Send> {
    inner: Mutex<Option<FinalizeWrapper<T>>>,
}

impl<T: MutableFinalize + Send + 'static> OpaqueOutboundHandle<T> {
    pub const fn new(inner: T) -> Self {
        Self {
            inner: Mutex::new(Some(FinalizeWrapper::new(inner))),
        }
    }
}

impl<T: MutableFinalize + Send + 'static> TryIntoJs for OpaqueOutboundHandle<T> {
    type Output = JsBox<Rc<FinalizeWrapper<T>>>;
    fn try_into_js<'cx>(self, cx: &mut impl Context<'cx>) -> JsResult<'cx, Self::Output> {
        let inner = self
            .inner
            .lock()
            .take()
            .ok_or(BridgeError::IllegalStateAlreadyClosed {
                what: any::type_name::<T>()
                    .rsplit("::")
                    .next()
                    .unwrap_or("Resource"),
            })
            .into_throw(cx)?;

        Ok(cx.boxed(Rc::new(inner)))
    }
}

/// See `OpaqueOutboundHandle` for details.
pub struct OpaqueInboundHandle<T>
where
    T: MutableFinalize + 'static,
{
    inner: Rc<FinalizeWrapper<T>>,
}

impl<T> TryFromJs for OpaqueInboundHandle<T>
where
    T: MutableFinalize + 'static,
{
    fn try_from_js<'cx, 'b>(
        cx: &mut impl Context<'cx>,
        js_value: Handle<'b, JsValue>,
    ) -> BridgeResult<Self> {
        let boxed = js_value.downcast::<JsBox<Rc<FinalizeWrapper<T>>>, _>(cx)?;
        Ok(Self {
            inner: Rc::clone(&**boxed),
        })
    }
}

impl<T> OpaqueInboundHandle<T>
where
    T: MutableFinalize + 'static,
{
    pub fn borrow(&self) -> BridgeResult<std::cell::Ref<'_, T>> {
        match Ref::filter_map(self.inner.inner.borrow(), std::option::Option::as_ref) {
            Ok(inner_ref) => Ok(inner_ref),
            Err(_guard) => Err(BridgeError::IllegalStateAlreadyClosed {
                what: any::type_name::<T>()
                    .rsplit("::")
                    .next()
                    .unwrap_or("Resource"),
            }),
        }
    }

    pub fn map<U>(&self, f: impl FnOnce(&T) -> U) -> BridgeResult<U> {
        Ok(f(&*self.borrow()?))
    }

    pub fn take(&self) -> BridgeResult<T> {
        // It is safe to ignore risks of conflicting borrows as OpaqueInbound are only
        // accessed while holding a Neon Context (indirectly), which itself guarantees
        // we are running synchronously with the single Node thread.
        match self.inner.inner.borrow_mut().take() {
            Some(x) => Ok(x),
            None => Err(BridgeError::IllegalStateAlreadyClosed {
                what: any::type_name::<T>()
                    .rsplit("::")
                    .next()
                    .unwrap_or("Resource"),
            }),
        }
    }

    #[must_use]
    pub fn try_take(&self) -> Option<T> {
        self.inner.inner.borrow_mut().take()
    }
}

pub struct FinalizeWrapper<T: MutableFinalize> {
    inner: RefCell<Option<T>>,
}

impl<T: MutableFinalize> FinalizeWrapper<T> {
    pub const fn new(inner: T) -> Self {
        Self {
            inner: RefCell::new(Some(inner)),
        }
    }
}

impl<T: MutableFinalize> Finalize for FinalizeWrapper<T> {
    fn finalize<'cx, C: Context<'cx>>(self, _: &mut C) {
        if let Some(inner) = self.inner.borrow_mut().take() {
            inner.finalize_mut();
        }
    }
}

pub trait MutableFinalize: Sized {
    /// Executed when the handle is dropped (should always be from the JS side),
    /// unless the handle has already been taken (e.g. by `take_inner`).
    fn finalize_mut(self) {}
}

impl<T: MutableFinalize> Finalize for OpaqueInboundHandle<T> {
    fn finalize<'cx, C: Context<'cx>>(self, _: &mut C) {
        if let Some(inner) = self.try_take() {
            inner.finalize_mut();
        }
    }
}

impl<T: MutableFinalize> Drop for FinalizeWrapper<T> {
    fn drop(&mut self) {
        if let Some(inner) = self.inner.borrow_mut().take() {
            inner.finalize_mut();
        }
    }
}
