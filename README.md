# Temporal TypeScript SDK

<p align="center">
  <a href="https://www.npmjs.com/search?q=author%3Atemporal-sdk-team">
    <img src="https://img.shields.io/npm/v/temporalio.svg?style=for-the-badge" alt="NPM" />
  </a>
  <a href="https://github.com/temporalio/sdk-typescript/blob/main/LICENSE.md">
    <img src="https://img.shields.io/npm/l/temporalio?style=for-the-badge" alt="LICENSE" />
  </a>
</div>

[Temporal](https://temporal.io) is a microservice orchestration platform that enables developers to build scalable applications without sacrificing productivity or reliability. Temporal Server executes units of application logic—Workflows—in a resilient manner that automatically handles intermittent failures and retries failed operations.

Temporal is a mature technology—it's a fork of Uber's Cadence. Temporal is being developed by Temporal Technologies, a startup by the creators of Cadence.

## Documentation

The documentation is divided into several sections:

- [TypeScript SDK docs](https://docs.temporal.io/typescript/introduction)
- [TypeScript SDK API reference](https://typescript.temporal.io/)
- [General Temporal docs](https://docs.temporal.io)

We welcome help improving the docs. You can submit issues for things that aren't clear or send pull requests to this repository (for the API reference) or to the [`docs.temporal.io` repository](https://github.com/temporalio/documentation) (for everything else).

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
| [`packages/common/lib/internal-workflow/`](packages/common/lib/internal-workflow/)         | [`@temporalio/common/lib/internal-workflow`](https://www.npmjs.com/package/@temporalio/common/lib/internal-workflow)         |
| [`packages/common/lib/internal-non-workflow/`](packages/common/lib/internal-non-workflow/) | [`@temporalio/common/lib/internal-non-workflow`](https://www.npmjs.com/package/@temporalio/common/lib/internal-non-workflow) |
| [`packages/meta/`](packages/meta/)                                                 | [`temporalio`](https://www.npmjs.com/package/@temporalio/meta) (deprecated)                                          |
| [`packages/test/`](packages/test/)                                                 | SDK internal tests                                                                                                   |
| [`packages/create-project/`](packages/create-project/)                             | [`@temporalio/create`](https://www.npmjs.com/package/@temporalio/create-project)                             |
| [`packages/docs/`](packages/docs/)                                                 | [API docs](https://typescript.temporal.io/)                                                                          |

## Contributors

[/sdk-typescript/graphs/contributors](https://github.com/temporalio/sdk-typescript/graphs/contributors)

Thank you to everyone who has contributed 😃🙌

## Contributing

We welcome issues and PRs! Read our [contributing guide](CONTRIBUTING.md) to learn about our development process, how to propose bugfixes and improvements, and how to build and test your changes to the SDK.