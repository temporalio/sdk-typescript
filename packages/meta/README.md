# Temporal Node.js SDK

<p align="center">
  <img src="https://img.shields.io/github/workflow/status/temporalio/sdk-node/Continuous%20Integration?style=for-the-badge" alt="CI" />
  <a href="https://www.npmjs.com/package/temporalio">
    <img src="https://img.shields.io/npm/v/temporalio.svg?style=for-the-badge" alt="NPM" />
  </a>
  <img src="https://img.shields.io/npm/l/temporalio?style=for-the-badge" alt="LICENSE" />
</div>

Temporal is a microservice orchestration platform which enables developers to build scalable applications without sacrificing productivity or reliability. Temporal server executes units of application logic—Workflows—in a resilient manner that automatically handles intermittent failures and retries failed operations.

Temporal is a mature technology—it's a fork of Uber's Cadence. Temporal is being developed by [Temporal Technologies](https://temporal.io), a startup by the creators of Cadence.

## Documentation

Check out the [Getting started](https://docs.temporal.io/docs/node/getting-started) page for a quick overview.

The documentation is divided into several sections:

- [Node SDK docs](https://docs.temporal.io/docs/node/introduction)
- [Node SDK API reference](https://nodejs.temporal.io/)
- [General Temporal docs](https://docs.temporal.io)

You can improve it by sending pull requests to this repository (for the API reference) or to the [documentation repository](https://github.com/temporalio/documentation).

## This SDK is in alpha

### Features

Mostly complete implementation of all components that make up a Temporal SDK - Worker, Client, Workflows, and Activities

- General
  - Cancellation
  - Interceptors
- Workflows
  - Scheduling timers
  - Scheduling (non-local) Activities
  - Cancelling timers and Activities
  - Signals
  - Queries
- Activities (complete)
- Client (complete)
  - Workflow client
  - Service client (for administration)
- Worker (mostly complete)
  - Basic logging and tracing capabilities
  - Sticky Workflow execution

Notably these features are missing:

- Telemetry
- Workflow versioning
- Local activities
- Side effects
- Search attributes
- Windows support

> NOTE: The API is considered unstable and may change at any time.
> While in alpha we are gathering feedback from developers about the usability and ergonomics of the API.
> To provide feedback please [open an issue](https://github.com/temporalio/sdk-node/issues) and feel free to
> talk to us on the [#nodejs-sdk community slack channel](https://temporal.io/slack) or post on our [discourse support forum](https://community.temporal.io/).

## Installation

See the [getting started](https://docs.temporal.io/docs/node/getting-started) guide for setting up a project on your laptop.

## Contributing

Read our [contributing guide](https://github.com/temporalio/sdk-node/blob/main/CONTRIBUTING.md) to learn about our development process, how to propose bugfixes and improvements, and how to build and test your changes to the SDK.
