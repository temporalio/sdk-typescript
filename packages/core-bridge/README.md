# `@temporalio/core-bridge`

[![NPM](https://img.shields.io/npm/v/@temporalio/core-bridge?style=for-the-badge)](https://www.npmjs.com/package/@temporalio/core-bridge)

Part of [Temporal](https://temporal.io)'s [TypeScript SDK](https://docs.temporal.io/typescript/introduction/).

> [!CAUTION]
> This package is not intended to be used directly. Any API provided
> by this package is internal and subject to change without notice.

## FIPS (experimental)

The prebuilt binaries use [`ring`](https://github.com/briansmith/ring) for TLS, which is not FIPS-validated. Building with
the `fips` Cargo feature restricts the bridge's TLS (`NativeConnection` and Core's HTTPS requests) to FIPS-approved
algorithms from AWS-LC's FIPS module. The module version, and so its validation status, follows the
[`aws-lc-rs`](https://github.com/aws/aws-lc-rs#fips) version in `Cargo.lock`. `Connection` from `@temporalio/client` uses
Node's TLS and is not affected.

The build needs Go, CMake, Perl and a C compiler, in addition to Rust and `protoc`.

From this repository:

```sh
TEMPORALIO_FIPS=1 pnpm --filter @temporalio/core-bridge run build-rust-release
```

From an application's `node_modules`:

```sh
cd node_modules/@temporalio/core-bridge
cargo build --release --no-default-features --features fips
cp target/release/libtemporal_sdk_typescript_bridge.so releases/x86_64-unknown-linux-gnu/index.node
```
