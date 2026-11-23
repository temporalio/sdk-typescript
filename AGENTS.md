# Contributor guidance for sdk-typescript

Use the commands in `CONTRIBUTING.md` for building and testing. Keep changes focused,
run targeted tests for changed behavior, and run relevant formatting and type checks.

For generating workflow histories or adding replay fixtures, follow
`docs/workflow-history-generation.md` before running commands. Write a capture test
in `packages/test`, copy/cherry-pick it and its workflow to a checkout of the
requested SDK tag, build with pnpm and that tag's pinned dependencies, then run the
capture test. Bring the JSON back and replay it with the current SDK. Keep the
workflow-driving code in an explicit opt-in capture path; normal tests replay only.
Use `testWorkflowHistory` from `packages/test/src/helpers-history.ts` to capture history. Register separate tests for scenarios.
Do not create a standalone project or substitute a current-version history.
Name fixtures by workflow, scenario, and SDK version.

For user-facing changes, add a Markdown fragment under `changelog/<category>/`.
Categories are `added`, `stabilized`, `changed`, `deprecated`, `breaking-changes`,
`fixed`, and `security`. Use `stabilized` when a feature is no longer experimental.
Use fun, whimsical, unique lowercase kebab-case filenames, such as
`tap-dancing-teapot.md`. Keep entries concise, ideally one or two sentences. Write
each entry on one line without a leading `-`; release tooling adds a bullet for
each nonempty line. Multiple entries per fragment are allowed.
`CHANGELOG.md` contains completed releases only. See `changelog/README.md`.

Update Core with `pnpm update-core`, which updates the pin, imports its changelog
entries with a `Core: ` prefix, and refreshes the bridge lockfile. Review and commit
these together. Regenerate protobuf output and check bridge compatibility as
needed. Follow `packages/core-bridge/sdk-core/AGENTS.md` when working on Core.

Release preparation uses `pnpm release:prepare VERSION` to update package versions
and the pnpm lockfile before invoking Core's shared changelog preparation command.
Use `pnpm release:notes --version VERSION` for publishing notes. Contributor
instructions belong in `CONTRIBUTING.md`; changelog assembly logic belongs in the
shared `changelog-release-notes` crate.
