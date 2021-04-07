## Building `temporal_sdk_node_bridge`

`temporal_sdk_node_bridge` is a native NodeJS module written in Rust using [neon](https://neon-bindings.com/).
One of the advantages of using Rust is that it's easy to cross compile to various platforms and architectures.

By using NodeJS' `n-api` we get a binary which _should_ work on all supported Node versions thanks to `n-api`'s [ABI stability](https://nodejs.org/en/docs/guides/abi-stability/).

### Setting up a MacOS build environment

1. Download [rustup](https://rustup.rs/).
1. Run `rustup target add x86_64-apple-darwin` - if you're using a mac with an M1 chip
1. Run `rustup target add aarch64-apple-darwin` - if you're using a mac with an Intel chip
<!-- 1. Run `rustup target add x86_64-pc-windows-msvc` -->
1. Run `rustup target add x86_64-pc-windows-gnu`
1. Run `rustup target add x86_64-unknown-linux-gnu`
1. Run `brew tap SergioBenitez/osxct`
1. Run `brew install x86_64-unknown-linux-gnu` to compile for linux
1. Run `brew install mingw-w64` to compile for windows
1. Configure cargo for the Windows and Linux build targets
   `~/.cargo/config.toml`

   ```toml
   [target.x86_64-unknown-linux-gnu]
   linker = "x86_64-unknown-linux-gnu-gcc"

   [target.x86_64-pc-windows-gnu]
   linker = "/usr/local/bin/x86_64-w64-mingw32-gcc"
   ```

1. Build the project with `TEMPORAL_WORKER_BUILD_ALL_TARGETS=1 npx lerna run --stream build-rust`
