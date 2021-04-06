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
1. Run `brew install llvm`
1. Run `brew install mingw-w64`
1. Run an Ubuntu container and copy relevant libs to your laptop:
   1. `mkdir ~/lib`
   1. `docker run -d --name ubuntu ubuntu sleep infinity`
   1. `docker container cp ubuntu:/usr/lib/x86_64-linux-gnu/ ~/lib/`
   1. `docker container rm -f ubuntu`
   1. `(cd ~/lib/x86_64-linux-gnu && for lib in dl util gcc_s rt pthread c m; do ln -snf lib${lib}.so{.*,}; done)`
1. Configure cargo for the Windows and Linux build targets
   `~/.cargo/config.toml`

   ```toml
   [target.x86_64-unknown-linux-gnu]
   linker = "/usr/local/opt/llvm/bin/lld"
   rustflags = "-L/Users/PUT_YOUR_USERNAME_HERE/lib/x86_64-linux-gnu/"

   [target.x86_64-pc-windows-gnu]
   linker = "/usr/local/bin/x86_64-w64-mingw32-gcc"
   ```

1. Build the project with `TEMPORAL_WORKER_BUILD_ALL_TARGETS=1 npx lerna run --stream build-rust`
