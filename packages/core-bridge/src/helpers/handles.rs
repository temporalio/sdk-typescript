use std::{
    any,
    cell::{Ref, RefCell},
    sync::Arc,
};

use neon::{prelude::*, types::JsBox};

use super::{BridgeError, BridgeResult, TryFromJs, TryIntoJs};

////////////////////////////////////////////////////////////////////////////////////////////////////

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
pub struct OpaqueOutboundHandle<T: Finalize + 'static> {
    inner: T,
}

impl<T: Finalize + 'static> OpaqueOutboundHandle<T> {
    // We late-wrap into Arc<Box<RefCell<>>> so that T can be send across threads without mutex.
    pub const fn new(inner: T) -> Self {
        Self { inner }
    }
}

impl<T: Finalize + 'static> TryIntoJs for OpaqueOutboundHandle<T> {
    type Output = JsBox<Arc<RefCell<Option<T>>>>;
    fn try_into_js<'cx>(self, cx: &mut impl Context<'cx>) -> JsResult<'cx, Self::Output> {
        Ok(cx.boxed(Arc::new(RefCell::new(Some(self.inner)))))
    }
}

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
pub struct OpaqueInboundHandle<T>
where
    T: 'static,
{
    inner: Arc<RefCell<Option<T>>>,
}

impl<T> TryFromJs for OpaqueInboundHandle<T>
where
    T: 'static,
{
    fn try_from_js<'cx, 'b>(
        cx: &mut impl Context<'cx>,
        js_value: Handle<'b, JsValue>,
    ) -> BridgeResult<Self> {
        let boxed = js_value.downcast::<JsBox<Arc<RefCell<Option<T>>>>, _>(cx)?;
        Ok(Self {
            inner: Arc::clone(&boxed),
        })
    }
}

impl<T: 'static> OpaqueInboundHandle<T> {
    pub fn borrow_inner(&self) -> BridgeResult<std::cell::Ref<'_, T>> {
        match Ref::filter_map(self.inner.borrow(), std::option::Option::as_ref) {
            Ok(inner_ref) => Ok(inner_ref),
            Err(_guard) => Err(BridgeError::IllegalStateAlreadyClosed {
                what: any::type_name::<T>()
                    .rsplit("::")
                    .next()
                    .unwrap_or("Resource"),
            }),
        }
    }

    pub fn map_inner<U>(&self, f: impl FnOnce(&T) -> U) -> BridgeResult<U> {
        Ok(f(&*self.borrow_inner()?))
    }

    pub fn take_inner(&self) -> BridgeResult<T> {
        // It is safe to ignore risks of conflicting borrows as OpaqueInbound are only
        // accessed while holding a Neon Context (indirectly), which itself guarantees
        // we are running synchronously with the single Node thread.
        match self.inner.borrow_mut().take() {
            Some(x) => Ok(x),
            None => Err(BridgeError::IllegalStateAlreadyClosed {
                what: any::type_name::<T>()
                    .rsplit("::")
                    .next()
                    .unwrap_or("Resource"),
            }),
        }
    }
}
