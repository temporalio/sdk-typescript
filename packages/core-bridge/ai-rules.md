# Bridge Layer Coding Norms, Best Practices and Pertinent Knowledge

This document captures the coding norms, best practices and key knowledge required to efficiently
contribute to development of the Rust ↔ TypeScript bridge layer of the Temporal TypeScript SDK.
This document is meant to guide both human developers and AI tools in maintaining consistency
and quality of the bridge layer.

## 1. Bridge Layer Design Philosophy

- **The bridge should be easy to maintain and review** — The bridge's code should clearly
  expose its actual business logic and types, notably by applying mechanical and systematic
  coding patterns that are easy to understand and verify.

  - The bridge layer is a fragile interface, as it breaks continuity of type safety guarantees
    that TypeScript and Rust provide at other levels. The risk of bugs caused by inconsistencies
    between the TS and Rust API definitions is real — we have in fact identified several such
    bugs in the past — and we are highly reliant on developer's and reviewer's scrutiny to
    catch those inconsistencies.

  - By keeping the bridge's code thin and focused, we can significantly improve the
    reviewability of API definitions between the TS and Rust sides, and therefore reduce
    the risks of such inconsistencies.

  - Care must notably be exercised to avoid drowning the bridge's main logic with JS/Rust
    object manipulations, tasks scheduling, and other plumbing concerns that add unreasonable
    complexity, hinder evolution and reviewability, and make it hard for new SDK developers
    to approach that codebase.

  - Complexity should be moved out of the bridge business logic, preferably to TypeScript
    user-facing packages or to the Core SDK project. Where complexity is unavoidable, it should
    be structured in a way that preserves reviewability of the bridge's business logic and
    types, for example by extracting it to appropriate abstractions and helpers (i.e., like
    we did with type conversions, errors, Futures, Callbacks, etc.).

  - Though not always possible, we should generally strive to align the TS SDK's bridge's logic
    with that of other official Temporal SDK bridges, as this makes it easier for our engineers
    to do cross-SDKs maintenance and development.

    - https://github.com/temporalio/sdk-python
    - https://github.com/temporalio/sdk-dotnet
    - https://github.com/temporalio/sdk-ruby

- **Bridge APIs are internal** — The bridge itself is an implementation detail and not meant to
  be used directly. SDK features and APIs are exposed to users exclusively through the user-facing
  packages: `@temporalio/worker`, `@temporalio/testing` and `@temporalio/common`.

  - The bridge provides absolutely no API stability guarantee, not even across patch-level
    releases. It is therefore required that the bridge and all public-facing packages be the
    same version number (i.e., combining SDK packages of different version is not supported).

  - All functions and types exposed by the TypeScript `core-bridge` package are internal.
    These should never be imported from user code, nor should they be reexported by our
    own user-facing packages.

- **Objects transferred through the bridge are DTO** — The bridge must define internal
  types specifically for the TS/Rust interface, independently of user-facing APIs defined
  by user-facing packages. These internal types follow the key principles of the well-known
  Data Transfer Object pattern.

  - As a general rule, bridge transfer types should mirror the corresponding Core SDK types
    except when doing so would be impractical. Alignment with user-facing types is not an
    objective. Moreover, transfer types must adhere to some particular constraints that
    will be described later in this document.

  - Bridge should only perform the minimal type validations that are strictly required as part
    of its type conversion and business logic. More comprehensive validations and transformations,
    including filling-in default values, preserving backward compatibility, converting from
    user-friendly types and more, belong to user-facing packages.

- **The bridge should be reliable** — As a critical component of the Temporal SDK, the bridge
  should be highly reliable, notably regarding object lifecycle management, memory usage, and
  concurrency challenges. Runtime performance should also not be neglected, though this is
  arguably less of a concern at the bridge level compared to other parts of the SDK.

## 2. Project Structure and Code Organization

- **Module Organization**:

  - On the Rust side, bridge API functions and types are defined in files under
    the `core-bridge/src` directory. Each major component has its own file
    (`client.rs`, `worker.rs`, etc.).

  - Configuration-related types for each major component are grouped in a nested
    `config` submodule inside that component's file.

  - Rust side helper functionalities are designed as proper abstractions inside the
    `helpers` module. Some abstractions are also provided through Derive Macros,
    defined in the `bridge-macros` crate.

  - On the TS side, bridge APIs (including functions and types) are declared in
    the `core-bridge/ts/native.ts` file.

  **Bridge API Functions**:

  - Component-specific prefix for API entrypoint functions (e.g., `client_new`,
    `worker_poll_activity_task`, etc.).

  - Function names are snake-case on the Rust side, but camel-case on the TS side.

- **Bridge API Types**:

  - On the Rust side, bridge types are defined in their respective component files
    (e.g., `client.rs`, `worker.rs`, etc.); configuration-related types are contained
    inside the `config` submodule of the component file.

  - On the TypeScript side, most types are defined in the `native.ts` file,
    collocated with API functions declarations of the same component.

- **Declaration order**:

  - As a general rule, functions, types and properties of types should have the
    same names in Rust and TypeScript (save for camel-case/snake-case equivalence
    where appropriate), and should be listed in the same order. This makes review
    significantly easier by allowing quick side-to-side comparison.

## 3. Type System

- **Type Conversion System**:

  - The bridge provides a type-safe conversion system between Rust and TypeScript
    through two main traits:

    - `TryFromJs` for JavaScript to Rust conversions
    - `TryIntoJs` for Rust to JavaScript conversions

  - These traits are implemented for primitive types, and can be derived for most struct and enums
    through the `#[derive(TryFromJs)]` and `#[derive(TryIntoJs)]` macros. Custom implementations
    are also possible to handle special cases.

- **Option Handling**:

  - The bridge uses the TypeScript value `null` (rather than `undefined`) to represent the `None`
    case of a value defined as `Option<T>` on objects that are sent through the bridge; the
    TypeScript mapped type `Option<T> = T | null` can be used to model such value.

  - All expected properties must be present and set to a non-`undefined` value on objects
    that are sent across the bridge; that notably means that properties on bridge types
    should never be declared with the `?` operator in TypeScript (e.g. there should be no
    property declared as `someProperty?: number`).

  - This design allows differentiation between "intentionally unspecified" values (`null`, meaning
    `None`) and "unintentionally missing" properties (`undefined`), which in turn allows early
    detection of some frequent incoherency patterns between type definition in JS and Rust.

  - Key rules:
    - Always use `null` for intentionally unspecified optional values
    - Never use TypeScript's optional property syntax (`prop?: T`)
    - Explicitly set all properties when sending objects to native code

- **`TryFromJs` and `TryIntoJs` derive macros**

  - When applied to a Rust enum type, the derive macros expects the corresponding JS type
    definition to contain a discriminator property named `type`, whose value must match the
    name of the desired enum variant in kebab-case. Other fields of the variant are read from the
    same JS object (a.k.a. "Internally tagged" in `serde`'s terminology). If an enum variant
    accepts a tupple composed of a single field, then that field is de/serialized from/into the
    object containing the `type` property. Refer to type `LogExporter` or `EphemeralServerConfig`
    for usage examples of these macros with enum types.

  - Note that the `TryFromJs` and `TryIntoJs` derive macros are designed to handle most of the
    patterns seen commonly in this code base; they are however far from being comprehensive. For
    more complex use cases, it is generally preferable to implement the desired trait manually.

- **JavaScript Function Exports**:

  - The bridge uses the `#[js_function]` derive macro to simplify the implementation of functions
    that are exported to JavaScript through Neon. This macro handles all the boilerplate required
    to safely convert JS arguments to Rust types and return values back to JavaScript.

  - A function decorated with `#[js_function]` must:

    - Accept only arguments that implements the `TryFromJs` trait;
    - Return a `BridgeResult<T>`, where T implements the `TryIntoJs` trait.

  - The macro actually expands into two functions:

    - The actual JS-facing function, with the original name, which handles JS argument extraction
      and conversion (i.e., using the `TryFromJs` trait to convert each argument to the specified
      type), as well as result conversion back to JS (i.e., using the `TryIntoJs` trait for the
      specified target type). It also ensures outbound conversion of `BridgeError` into Neon's
      `Throw` type (by using the `IntoThrow` trait).

    - An implementation function with an `_impl` suffix that contains the original function body
      and operates entirely on Rust types.

  - All functions meant to be called from JavaScript should be marked with this macro. The
    functions must also be registered on the Neon's `ModuleContext`, using the pattern seen
    in each component's `init` function:

    ```rust
    fn init(cx: &mut neon::prelude::ModuleContext) -> neon::prelude::NeonResult<()> {
        cx.export_function("functionName", function_name)?;
        // More exports...
        Ok(())
    }
    ```

  - Each component's `init` functions are called by Neon's bootstrap code, on initialization
    of the native module. See `core-bridge/src/lib.rs`.

- **Common Type Mappings**:

  The bridge supports the following type conversions between TypeScript and Rust:

  **TypeScript → Rust** (using `TryFromJs` trait):

  | TypeScript Type                             | Rust Type                                                   |
  | ------------------------------------------- | ----------------------------------------------------------- | --- |
  | `number`                                    | `u16`, `i32`, `f32`, `u64`, `f64`, `usize`                  | x   |
  | `number`                                    | `Duration` (from ms as `u64`)                               | x   |
  | `string`                                    | `String`                                                    | x   |
  | `boolean`                                   | `bool`                                                      | x   |
  | `T[]` or `Array<T>`                         | `Vec<T>`                                                    | x   |
  | `Record<string, T>` or `{[key: string]: T}` | `HashMap<String, T>`                                        | x   |
  | `string`                                    | `SocketAddr`                                                | x   |
  | `string`                                    | `Url`                                                       | x   |
  | `T \| null`                                 | `Option<T>`                                                 | x   |
  | `Buffer`                                    | `Vec<u8>`                                                   | x   |
  | `unknwon`                                   | `()` (empty tuple)                                          | x   |
  | `[T1, T2, ...]` - to be confirmed           | `(T1, T2, ...)` (tuple)                                     |
  | Function<Result, Args> - to be reworked     | `JsCallback<Args, Result>`, `JsAsyncCallback<Args, Result>` |
  | `OpaqueHandle<T>` - to be reworked          | `OpaqueInboundHandle<T>`                                    |

  **Rust → TypeScript** (using `TryIntoJs` trait):

  | Rust Type                                  | TypeScript Type            |
  | ------------------------------------------ | -------------------------- | --- |
  | `String`                                   | `string`                   | x   |
  | `bool`                                     | `boolean`                  | x   |
  | `Vec<T>`                                   | `T[]`                      | x   |
  | `SystemTime`                               | `bigint` (as nano seconds) | x   |
  | `()` (unit tuple)                          | `undefined`                | x   |
  | `(T1, T2, ...)` (tuple) - to be confirmed  | `[T1, T2, ...]`            |
  | `Option<T>`                                | `T \| null`                | x   |
  | `Vec<u8>`                                  | `Buffer`                   | x   |
  | `HashMap<String, T>` - to be confirmed     | `Record<string, T>`        |
  | `BridgeFuture<T>` - to be reworked         | `Promise<T>`               |
  | `OpaqueOutboundHandle<T>` - to be reworked | `OpaqueHandle<T>`          |

  These mappings form the foundation of the interoperability between TypeScript and Rust in the bridge.

  For more complex cases, manual implementations of the `TryFromJs` and `TryIntoJs` traits may be needed.

## 4. Error Handling

- **Error Types and Results**:

  - The bridge defines the `BridgeError` enum, as well as an associated `BridgeResult<T>` type
    alias, which are the preferred types to report and propagate errors in the bridge layer.
    The `BridgeError` enum notably provides the following advantages:

    - They can transparently encapsulate an already "thrown" `Throw` object, thus allowing
      propagation through intermediate function calls that are not JS `Context` aware,
      then rethrow the `Throw` when appropriate.

    - They can be emitted from a non-`Context`-aware function, and may even be sent across
      threads to be finally converted to a `Throw` object if/once propagation reaches a
      `Context` aware parent. The JS Error type is automatically determined based on the
      variant of the `BridgeError`, including the possibility of sending some bridge specific
      error types (see Custom JS Error Classes below).

    - They allow enrichment of errors with contextual information that are provided while
      propagating the error up through the call stack, either through `anyhow`'s `.context(...)`
      method, or the `BridgeError`'s specific `.field(...) method.

  - Functions that return a `JsResult` or `NeonResult` (which implies they have access to
    a live `Context`), such as implementations of the `TryIntoJs` and `js_function` traits,
    are responsible for converting back `BridgeResult` into `Throw`, e.g. by calling
    `BridgeResult::into_throw(result, cx)?`.

  - Note that Neon's `Throw` objects can't be `Send`, _not even when wrapped in a `BridgeError`_
    (there is anyway rarely use cases that would implies such thing). With very few exceptions
    (noted in Neon's typedocs), once a `Throw` object has been created, the Node thread is in
    a "throwing" state, and any further call to any `Context` object will cause a panic; the
    "throwing" state remains until the `Throw` object is finally propagated back to the JS caller.

- **Error Context**:

  - Always use the `.field()` method on `BridgeResult` to add context to errors when accessing
    object properties on JS objects; each call to `field()` _prepends_ a path component, resulting
    in a complete path to problematic value once the error has propagated all the way up
    (e.g. `fn some_func.args[4].foo.bar: ...`). Note that the `TryFromJs` and `js_function`
    derive macros, and most existing helpers already add field context; extra work is only
    required when manually implementing the `TryFromJs` trait or when reaching for helpers
    that do not add context.

  - Always use the `.context()` method on `BridgeResult` to add context to errors that are
    automatically converted from foreign errors or `BridgeResult` that are propagated up
    through the caller stack, unless the error itself already provides sufficient context.

- **Custom JS Error Classes**:

  - The Neon API provides built-in support for the following standard JS errors: `Error`,
    `TypeError` and `RangeError`. The bridge also adds support for the following custom JS
    errors: `IllegalStateError`, `UnexpectedError`, `TransportError` and `ShutdownError`.

  - Custom JS error classes are defined in `core-bridge/ts/errors.ts` file (for the TS class
    definition and name-to-class conversion) and in `core-bridge/src/helpers/errors.rs` (for
    the Rust counterpart). Both of these files must be kept in sync.

  - Note that the Rust code does not actually instantiate the proper JS classes, as those are
    not accessible from the native code (i.e., they are not exposed as globals or on any object
    currently accessible to the native bridge). Instead, the Rust code creates instances of the
    `Error` class, then simply overrides the `name` property of the error object. Those error
    objects are then replaced with instances of the appropriate error classes by a pure-JS wrapper
    that is added on load of the native library (see `core-bridge/index.js`).

## FIXME: Anything below this point is incomplete / not reviewed

## 5. Asynchronous Operations and Thread Safety

- **Future and Promise Handling**:

  - Consistent use of `future_to_promise()` to convert Rust futures to JS promises
  - Extension trait `RuntimeExt` to simplify working with futures
  - Clear distinction between sync and async functions
  - Proper typing of Promise results
  - Careful handling of async error propagation

- **Thread Safety**:

  - Strict separation between JS and Rust threads
  - Careful handling of JS contexts to avoid using them across threads
  - Use of the `enter_sync!` macro when entering tokio context
  - Proper synchronization of shared resources
  - Use of `Arc` and `Mutex` for thread-safe data sharing
  - Clear documentation of thread safety requirements

- **Concurrency Patterns**:
  - Consistent patterns for handling concurrent operations
  - Clear documentation of thread safety guarantees
  - Proper handling of cancellation and timeouts
  - Careful management of async resources

## 6. Resource and Handle Management

- **Handle Types**:

  - Use of `OpaqueInboundHandle<T>` and `OpaqueOutboundHandle<T>` to safely pass Rust objects to/from JS
  - TypeScript interfaces for handles with type discriminators
  - Consistent patterns for borrowing (`borrow_inner()`) and taking ownership (`take_inner()`)
  - Implementation of `Finalize` trait for proper cleanup

- **Resource Lifecycle**:

  - Clear patterns for resource creation and destruction
  - Proper cleanup in error cases
  - Thread-safe resource management
  - Documentation of resource ownership and lifetime

- **Memory Management**:
  - Careful management of object lifecycles
  - Proper cleanup of resources in error cases
  - Efficient memory usage patterns
  - Clear documentation of memory management requirements

## 7. Code Style and Naming Conventions

- **Rust Code Style**:

  - Use of `/////` line separators to visually divide sections of code
  - Standard library imports first, external crate imports next, internal imports last
  - Organized by category with blank lines between groups
  - Consistent parameter ordering (handles first, then configuration)
  - Clear module organization and file structure

- **TypeScript Code Style**:

  - Consistent use of TypeScript features
  - Clear type definitions and interfaces
  - Proper use of type aliases and enums
  - Consistent file organization

- **Naming Conventions**:
  - PascalCase for types (`BridgeWorkerOptions`, `EphemeralServer`)
  - snake_case for Rust functions and variables
  - camelCase for TypeScript functions and variables
  - Consistent naming patterns (`Core` prefix for sdk-core types)
  - Clear and descriptive names for all identifiers

## 8. Documentation, Testing, and Review

- **Code Documentation**:

  - Doc comments on public functions and types
  - Clear explanations of complex patterns
  - Comments for non-obvious code sections
  - Use of `// FIXME: ...` comments for issues that need attention
  - Examples of proper usage

- **Testing Guidelines**:

  - Unit tests for all bridge functions
  - Integration tests for complex interactions
  - Tests for error cases and edge conditions
  - Performance tests for critical paths
  - Clear test organization and naming

- **Review Guidelines**:
  - Function names must match exactly (camelCase in TypeScript, snake_case in Rust)
  - Parameter order must be identical on both sides
  - Field names must match exactly (camelCase in TypeScript, snake_case in Rust)
  - Field order should match to make review easier
  - Nested structures must maintain the same hierarchy
  - Comments and documentation should be consistent
  - Type definitions should be in the same order for easy review
  - Thread safety considerations must be documented
  - Resource cleanup must be verified

============

Extra notes:

- It is not immediately obvious that implementing Neon's `Finalize` for our types provides
  any real advantage over implementing `Drop` (or just doing nothing!). Finalize provides a
  `Context` and therefore execute on Node thread, which could be pertinent for some operations,
  but doesn't seem fit our use cases. Implementing `Drop` should be sufficient in most cases,
  and may feel more natural to Rust developers.
