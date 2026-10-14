# Dependency cooldown

Dependabot's 14-day `cooldown` applies to version updates, not security updates.
For a security fix, its updater can disable PNPM's release-age gate for the entire
lockfile resolution. That can also introduce immature, unrelated dependencies.
Our **Dependency cooldown** check independently gates what can be merged.

## What the check enforces

- Compare registry package/version identities in changed PNPM v9 and npm v2/v3
  lockfiles (`package-lock.json` and `npm-shrinkwrap.json`) with the package/version
  identities already present in the base branch's tracked lockfiles. Peer contexts
  and duplicate paths do not create new versions.
- Enumerate immutable Git trees and fetch blobs by SHA, checking their hashes.
  Direct npm registry tarballs are audited by their actual identities; a tarball
  that disagrees with the lockfile's claimed package/version is rejected.
- Require newly introduced versions to satisfy the base branch's
  `minimumReleaseAge` from `pnpm-workspace.yaml`.
- Honor the existing `minimumReleaseAgeExclude` selectors, but report every
  effective exclusion rather than silently ignoring it.
- Otherwise, allow only an exact package/version exception already approved on the
  base branch. A security PR, label, or exception added in the same PR does not
  authorize a bypass.
- Fail closed if lockfiles, policy, registry publication dates, or complete Git
  trees cannot be verified. Also fail if the full bypass report exceeds the
  workflow-summary size bound, rather than silently hide exceptions.

Existing versions are grandfathered: this check does not retroactively block
unrelated PRs because an immature version was previously merged. It checks npm
registry versions, not local/file/git dependencies or GitHub Actions references.

The workflow uses `pull_request_target` but checks out **only the trusted base
branch**. PR lockfiles are retrieved through GitHub's API and parsed as data.
No PR code, dependencies, or lifecycle scripts run with the reporting token.
The token is never sent to the npm registry.
Head/base snapshots are revalidated before inspection and reporting.

This is an npm publication-age check, not an artifact-integrity or registry-routing
policy. It assumes ordinary registry identities refer to public npm; noncanonical
HTTP tarball sources fail closed. Private registries, local/file/git dependencies,
and changes to registry configuration need their own source/trust review.

## Approving a necessary exception

Prefer the smallest compatible security fix and retain mature transitive
dependencies where their ranges allow it. For example, MCP SDK `1.31.0` requires
`express-rate-limit: ^8.2.1`; that upgrade does not require replacing a compatible
`express-rate-limit@8.3.0` with `8.7.1`.

If an immature version is necessary, first make a small policy PR modifying
`.github/dependency-cooldown-exceptions.json`:

```json
{
  "exceptions": [
    {
      "package": "@modelcontextprotocol/sdk",
      "version": "1.31.0",
      "advisory": "GHSA-6qxp-vccf-f47h",
      "reason": "Minimum fixed version for the OAuth credential-disclosure advisory."
    }
  ]
}
```

This is an example, not a granted exception. Versions must be exact, and `reason`
is required. `advisory` is optional for cases such as a transitive version strictly
required by a security fix; explain the parent dependency and constraint in
`reason` instead.

The policy PR must receive the repository's required code-owner review before
merging. Reviewers must establish necessity; the check deliberately does not
pretend to prove that a whole dependency graph has no mature alternative.
Do not approve collateral refreshes merely because they arrived in a security PR.

After merging the policy PR, update/rebase the dependency PR to include the current
base branch, then rerun **Dependency cooldown** with that PR's number using its
workflow-dispatch input. The exception does not broaden the package's allowed
range, and stops acting as a bypass once that version matures.
Remove obsolete entries during subsequent policy maintenance.

Every effective bypass produces:

- A warning annotation.
- A workflow summary and sticky PR comment showing the exact package/version,
  publication time, age, earliest normal eligibility, and justification/advisory.
- A check report tied to the audited head SHA and trusted base SHA.

The policy is a merge gate. It does not change Dependabot's resolver or
automatically grant PNPM permission to regenerate a lockfile locally. Avoid
global `minimumReleaseAge=0` overrides when manually preparing updates.

## Activation and testing

Activation requires repository/organization administration; this PR does not
create an App, write secrets, or change rulesets:

1. Create a dedicated GitHub App, installed only on this repository, with
   **Contents: read**, **Pull requests: write**, and **Checks: write**.
2. Create the `dependency-cooldown` GitHub environment. Restrict its deployment
   branches to **only `main`**; do not permit PR merge refs, tags, or feature
   branches. Store `DEPENDENCY_COOLDOWN_APP_ID` as an environment variable and
   `DEPENDENCY_COOLDOWN_APP_PRIVATE_KEY` as an environment secret, not a
   repository-wide secret. Do not share this App/key with unrelated workflows.
3. After merging the workflow, dispatch it for a PR. It creates the
   **Dependency cooldown** check explicitly on that PR's head SHA and posts its
   report using the dedicated App.
4. Add **Dependency cooldown**, selecting **that dedicated App as the expected
   source**, to the `main` ruleset's required checks. Requiring a same-named
   GitHub Actions check alone would allow another PR workflow to impersonate it.
5. Enable **Require branches to be up to date before merging**. This prevents an
   old successful head check from outliving a changed base policy or revoked
   exception. The guard also rejects divergent branches during inspection.

The workflow's own GitHub Actions job is attached to the base branch and is not a
substitute for the dedicated App's required head check. Other target branches are
not supported by this initial workflow.

To run the offline unit and orchestration tests:

```sh
pnpm install --frozen-lockfile
pnpm run test:dependency-cooldown
```

The existing lint/conventions workflow also runs these tests. The privileged
reporting workflow becomes active only after it exists on the target branch;
initial policy and workflow changes therefore require ordinary review.
