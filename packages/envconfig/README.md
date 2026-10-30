# `@temporalio/envconfig`

[![NPM](https://img.shields.io/npm/v/@temporalio/envconfig?style=for-the-badge)](https://www.npmjs.com/package/@temporalio/envconfig)

Part of [Temporal](https://temporal.io)'s [TypeScript SDK](https://docs.temporal.io/typescript/introduction/).

Loads [client environment configuration](https://docs.temporal.io/develop/environment-configuration) from a TOML
config file and `TEMPORAL_*` environment variables:

```ts
import { Client, Connection } from '@temporalio/client';
import { loadClientConnectConfig } from '@temporalio/envconfig';

const { connectionOptions, namespace } = loadClientConnectConfig();
const connection = await Connection.connect(connectionOptions);
const client = new Client({ connection, namespace });
```

By default, configuration is loaded from `TEMPORAL_CONFIG_FILE` or the platform-specific user configuration
directory, then overridden by supported `TEMPORAL_` environment variables.

## Extensions

> [!NOTE]
> Extensions are experimental; APIs may change without notice.

Separately packaged modules can add their own configuration and client behavior by implementing
`ClientConfigExtension`. Each extension owns a TOML table under `ext` in each profile, which is available to the
extension as raw data on `ClientConfigProfile.ext`:

```toml
[profile.default.ext.my_extension]
some_field = "value"
```

Strict mode (`configFileStrict`) never rejects keys under `ext`, whether or not a matching extension is loaded.

Pass extensions to `loadClientConnectConfig`; each is called in order with the loaded profile and environment, and any
plugin it returns is appended to `connectionOptions.plugins`:

```ts
const { connectionOptions, namespace } = loadClientConnectConfig({
  extensions: [new MyExtension()],
});
```

Since `connectionOptions` may be passed to either `Connection.connect` or `NativeConnection.connect`, a plugin that
modifies connection options should implement both `configureConnection` and `configureNativeConnection` (as
`SimplePlugin` from `@temporalio/plugin` does). Plugins can also implement other plugin interfaces such as
`ClientPlugin` or `WorkerPlugin`, since a connection's plugins are passed on to clients and workers built from it.

```ts
import type { ClientConfigExtension, ClientConfigExtensionRequest } from '@temporalio/envconfig';
import { SimplePlugin } from '@temporalio/plugin';

/** Sets the API key from `profile.<profile>.ext.my_extension.api_key` or `TEMPORAL_EXT_MY_EXTENSION_API_KEY`. */
class MyExtension implements ClientConfigExtension {
  readonly name = 'my_extension';

  clientPlugin({ profile, env }: ClientConfigExtensionRequest): SimplePlugin | undefined {
    const raw = env?.['TEMPORAL_EXT_MY_EXTENSION_API_KEY'] ?? profile.ext?.[this.name]?.['api_key'];
    if (raw === undefined) {
      return undefined;
    }
    if (typeof raw !== 'string') {
      throw new TypeError('api_key must be a string');
    }
    return new SimplePlugin({ name: 'my-extension', apiKey: raw, tls: (tls) => tls ?? true });
  }
}
```

Extensions are recommended to use a `TEMPORAL_EXT_<NAME>_` prefix for their environment variables.
