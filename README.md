## HTTP CONNECT Example

Workers set the proxy details on the connection configuration, eg;

```js
  const connection = await NativeConnection.connect({
    address: 'localhost:7233',
    proxy: {
      targetHost: '127.0.0.1:8888',
      basicAuth: {
        'username': 'user',
        'password': 'password',
      }
    },
  });
```

Clients set the proxy details using the `http_proxy` environment variable, eg

```
http_proxy=http://user:password@127.0.0.1:8888 ts-node src/client.ts
```

---


<p align="center">
  <img src="https://assets.temporal.io/w/ts.png" alt="Temporal TypeScript SDK" />
</p>
<p align="center">
  <a href="https://www.npmjs.com/search?q=author%3Atemporal-sdk-team">
    <img src="https://img.shields.io/npm/v/temporalio.svg?style=for-the-badge" alt="NPM" />
  </a>
  <a href="https://github.com/temporalio/sdk-typescript/blob/main/LICENSE.md">
    <img src="https://img.shields.io/npm/l/temporalio?style=for-the-badge" alt="LICENSE" />
  </a>
</p>

[Temporal](https://temporal.io) is a durable execution system that transparently makes your code durable, fault-tolerant, and simple.

"Temporal TypeScript SDK" is the framework for authoring workflows and activities using either the TypeScript or JavaScript programming languages.

For documentation and samples, see:

- [Code Samples](https://github.com/temporalio/samples-typescript)
- [TypeScript SDK docs](https://docs.temporal.io/typescript/introduction)
- [TypeScript SDK API reference](https://typescript.temporal.io/)
- [General Temporal docs](https://docs.temporal.io)

## Packages

This monorepo contains the following packages:

| Subfolder                                                                          | Package                                                                                                              |
|------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------|
| [`packages/client/`](packages/client/)                                             | [`@temporalio/client`](https://www.npmjs.com/package/@temporalio/client)                                             |
| [`packages/worker/`](packages/worker/)                                             | [`@temporalio/worker`](https://www.npmjs.com/package/@temporalio/worker)                                             |
| [`packages/workflow/`](packages/workflow/)                                         | [`@temporalio/workflow`](https://www.npmjs.com/package/@temporalio/workflow)                                         |
| [`packages/activity/`](packages/activity/)                                         | [`@temporalio/activity`](https://www.npmjs.com/package/@temporalio/activity)                                         |
| [`packages/testing/`](packages/testing/)                                           | [`@temporalio/testing`](https://www.npmjs.com/package/@temporalio/testing)                                           |
| [`packages/common/`](packages/common/)                                             | [`@temporalio/common`](https://www.npmjs.com/package/@temporalio/common)                                             |
| [`packages/proto/`](packages/proto/)                                               | [`@temporalio/proto`](https://www.npmjs.com/package/@temporalio/proto)                                               |
| [`packages/interceptors-opentelemetry/`](packages/interceptors-opentelemetry/)     | [`@temporalio/interceptors-opentelemetry`](https://www.npmjs.com/package/@temporalio/interceptors-opentelemetry)     |
| [`packages/meta/`](packages/meta/)                                                 | [`temporalio`](https://www.npmjs.com/package/@temporalio/meta) (deprecated)                                          |
| [`packages/test/`](packages/test/)                                                 | SDK internal tests                                                                                                   |
| [`packages/create-project/`](packages/create-project/)                             | [`@temporalio/create`](https://www.npmjs.com/package/@temporalio/create-project)                                     |
| [`packages/docs/`](packages/docs/)                                                 | [API docs](https://typescript.temporal.io/)                                                                          |

## Contributors

[/sdk-typescript/graphs/contributors](https://github.com/temporalio/sdk-typescript/graphs/contributors)

Thank you to everyone who has contributed 😃🙌

## Contributing

We welcome issues and PRs! Read our [contributing guide](CONTRIBUTING.md) to learn about our development process, how to propose bugfixes and improvements, and how to build and test your changes to the SDK.
