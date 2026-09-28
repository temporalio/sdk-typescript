# Contributing to Temporal SDKs

Thanks for your interest in contributing to Temporal SDKs.

This guide describes expectations that apply across Temporal SDK repositories. Each
repository may have additional local conventions, but the guidance below should help
you open issues and pull requests that maintainers can evaluate efficiently.

## Before You Open an Issue

Search the existing issues first. If you find an issue that describes the same bug,
feature request, or design topic, add any relevant details there instead of opening a
duplicate. Use an upvote on the issue to show that it affects you too.

Issues are assigned to people when they are actively working on them. Before taking
on an issue, check whether it is already assigned so you do not duplicate someone
else's work.

Use GitHub issues for actionable bugs and feature work. For usage questions, help
debugging an application, or general discussion, join the relevant
language-specific channel in the
[Temporal community Slack](https://temporal.io/slack) or use the support channel
available to you.

## Bug Reports

When reporting a bug, include enough detail for someone else to reproduce or
understand the problem:

- A short summary of the problem.
- A minimal reproduction, preferably as code that can be copied into a small
  project or test.
- What you expected to happen and what actually happened.
- The SDK version.
- The language runtime version.
- The operating system and architecture.
- Temporal Server or Temporal Cloud details, if the issue depends on service
  behavior.
- Logs, stack traces, workflow histories, or other diagnostics that show the
  failure.
- Whether the behavior is a regression, and the last version where it worked if
  known.

## Feature Requests and Design Changes

Open or join a GitHub issue before starting substantial feature work, behavior
changes, or API design changes. This gives maintainers and other SDK users a chance
to discuss the approach before you invest in a larger implementation.

The relevant language-specific channel in Temporal community Slack is also a good
place for early discussion, but important decisions should still be captured in a
GitHub issue so they are visible and searchable.

Small bug fixes, documentation fixes, and narrowly scoped maintenance changes can go
straight to a pull request.

## Pull Requests

Good pull requests are focused and easy to review:

- Keep each pull request scoped to one logical change.
- Include tests for behavior changes.
- Update public API documentation or doc comments when public behavior changes.
- Add a high-level changelog entry for user-facing changes according to the
  repository's local changelog convention.
- Describe what changed, why it changed, and what validation you ran.

Run the relevant local checks when practical. CI must pass before a pull request can
be merged.

## Things to Avoid

Avoid changes that make review harder without improving the contribution:

- Unrelated refactors mixed into a behavior change.
- Style-only churn.
- Large feature pull requests that were not discussed first.
- License, copyright, or other legal changes without maintainer discussion.

## AI-Generated Contributions

Using AI tools while contributing is acceptable. You are responsible for the
correctness, quality, and maintainability of everything you submit.

Contributors must fully understand theissue they are fixing and be able to explain
the proposed change. We expect that human understanding to be evident in pull
request responses and design discussions. If a contribution's interaction appears
entirely AI-driven, maintainers may close it: it does not provide a benefit over
maintainers using AI tooling themselves.

Thoroughly self-review AI-generated code and documentation before opening a pull
request. Make sure it is correct, tested where appropriate, and consistent with the
style and patterns of the codebase.

Keep AI-assisted changes concise and scoped. Avoid verbose generated prose,
unnecessary comments, or broad rewrites that make the change harder to review.

## Contributor License Agreement

All contributors must complete the Temporal Contributor License Agreement (CLA)
before changes can be merged. A link to the CLA will be posted in the pull request.

## Security Issues

Do not open public GitHub issues for suspected security vulnerabilities. Report them
to security@temporal.io instead.

## Review and CI

Maintainers review pull requests for correctness, compatibility, test coverage,
documentation, and long-term maintainability. Review may require changes before a
pull request can be merged, and it may take maintainers some time to review a
contribution.

CI is the final validation gate. If CI fails, update the pull request or ask for help
if the failure appears unrelated to your change. Some CI gates may wait for a
maintainer to approve or run them.

## Inactive Pull Requests

Maintainers may close inactive pull requests after follow-up if they are no longer
moving forward. If that happens, you are welcome to reopen the pull request or open a
new one when you are ready to continue.

## Community Conduct

Keep discussions respectful, constructive, and focused on the work. Clear context,
specific examples, and patience with review feedback help everyone move faster.

## Development

After your environment is set up, you can run these commands:

- `pnpm build` compiles protobuf definitions, Rust bridge, C++ isolate extension, and Typescript.
- `pnpm run rebuild` deletes all generated files in the project and reruns build.
- `pnpm build:watch` watches filesystem for changes and incrementally compiles Typescript on change.
- `pnpm test` runs the test suite. Tests assume you have a [Temporal server running locally](https://docs.temporal.io/cli#start-dev-server).
- `pnpm test:watch` runs the test suite on each change to Typescript files.
- `pnpm format` formats code with prettier.
- `pnpm lint` verifies code style with prettier and ES lint.
- `pnpm commitlint` validates [commit messages](#style-guide).

To regenerate System Nexus bindings from Core's upstream API WIT files, install the pinned nexgen
release with its `advanced` feature and ensure `protoc` is on your `PATH`:

```sh
cargo install nexgen --version '=0.2.6' --locked --features advanced
pnpm --filter @temporalio/workflow run gen:system-nexus
```

CI uses the same release and checks that the generated bindings are up to date. Set `NEXGEN_BIN`
to use a local generator build when developing nexgen changes.

### Working with Individual Packages

You can build or test a single package using pnpm's filter flag:

```sh
# Build a single package and all its dependencies explicitly
pnpm -F @temporalio/worker... run build

# Run tests for a single package
pnpm -F @temporalio/common run test
```

The `...` suffix includes all dependencies of the specified package.

### Testing

#### Testing local changes to core

Create a `.cargo/config.toml` file and override the path to sdk-core and/or sdk-core-protos as
described [here](https://doc.rust-lang.org/cargo/reference/overriding-dependencies.html#paths-overrides)

##### Integration tests

In order to run integration tests:

1. Run the Temporal server, e.g. using the [Temporal CLI's integrated dev server](https://github.com/temporalio/cli#start-the-server)
1. Export `RUN_INTEGRATION_TESTS=true`

#### test-npm-init

To replicate the `test-npm-init` CI test locally, you can start with the below steps:

> If you've run `npx @temporalio/create` before, you may need to delete the version of the package that's stored in `~/.npm/_npx/`.

```
pnpm install --frozen-lockfile
pnpm run rebuild

TMP_DIR=$( mktemp -d )

pnpm tsx scripts/publish-to-verdaccio.ts --registry-dir "$TMP_DIR"
pnpm tsx scripts/init-from-verdaccio.ts --registry-dir "$TMP_DIR" --target-dir "./example" --sample hello-world
pnpm tsx scripts/test-example.ts --work-dir "./example"

rm -rf ./example "$TMP_DIR"
```

The publish and init steps print only a one-line summary; their full output is
written to `.test-results/` (and the tail is dumped to the console on failure).

### Style Guide

- Typescript code is linted with [eslint](https://eslint.org/)
- Files in this repo are formatted with [prettier](https://prettier.io/)
- Prefer explicit named re-exports and avoid wildcard re-exports where possible (`export * from ...`) in public entrypoint / barrel files.
- Use `@experimental` and `@internal` to manage API stability and visibility. Mark new or work-in-progress exported APIs `@experimental` to signal their shape may still change. Mark a symbol `@internal` to keep it out of the generated public docs. The two are independent and may be combined. It is fine to ship something `@internal` now and promote it to public later, by removing `@internal` and adding a named re-export, once it is actually usable. The reverse is a breaking change, so prefer starting narrow.
- Pull request titles SHOULD adhere to the [Conventional Commits specification](https://conventionalcommits.org/), for example:

```
<type>(optional scope): <description>

chore(samples): upgrade commander module
```

The `scope` options are listed in [commitlint.config.js](./commitlint.config.js).

## Updating and pruning dependencies

There are various tools out there to help with updating and pruning NPM dependencies.

I personally use the following commands to find NPM packages that needs to be updated. It runs
interactively on each package of the repo, making it easy to select and apply packages to be updated.

```
for i in ./package.json packages/*/package.json contrib/*/package.json ; do
  (
    cd "${i%%package.json}"
    pwd
    npm-check-updates -i
  )
done
```

To identify unused dependencies, I run the following script. Note that `npm-check` may report
false-positive. Search the code before actually deleting any dependency. Also note that runtime
dependencies MUST be added on the actual packages that use them to ensure proper execution in PNPM
and YARN 2+ setups.

```
for i in ./package.json packages/*/package.json contrib/*/package.json ; do
  (
    cd "${i%%package.json}"
    pwd
    npm-check
  )
done
```

To install both tools: `npm i -g npm-check npm-check-updates`.
