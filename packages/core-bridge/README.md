# `@temporalio/core-bridge`

[![NPM](https://img.shields.io/npm/v/@temporalio/core-bridge?style=for-the-badge)](https://www.npmjs.com/package/@temporalio/core-bridge)

Part of [Temporal](https://temporal.io)'s [TypeScript SDK](https://docs.temporal.io/typescript/introduction/).

> [!CAUTION]
> This package is not intended to be used directly. Any API provided
> by this package is internal and subject to change without notice.

## FIPS (experimental)

Prebuilt binaries are not FIPS-validated. To use [AWS-LC's FIPS module](https://github.com/aws/aws-lc-rs#fips)
for bridge TLS, build from source with `--fips` or `TEMPORALIO_FIPS=1`:

```sh
pnpm --filter @temporalio/core-bridge run build-rust-release --fips
```

Requires Rust, `protoc`, Go, CMake, Perl, and a C compiler. This does not affect
`Connection` from `@temporalio/client`, which uses Node's TLS.
