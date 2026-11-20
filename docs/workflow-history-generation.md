# Generating workflow histories

Capture existing workflow behavior on the requested SDK version, then verify that
the current SDK can replay it. Use the SDK repository's `test` package, workflows,
activities, converters, helpers, and pinned dependencies—not a separate project.

## Storage and generating code

Store readable Temporal JSON in `packages/test/history_files/`:

```text
<workflow>-<scenario>-sdk-<version>.json
```

Use kebab-case scenario names describing the behavior, e.g.
`smorgasbord-cancellation-sdk-1.24.0.json`. A history covers one workflow run;
when Continue-As-New creates more runs worth testing, save each history with its own replay test.
Do not concatenate different runs' events. Leave unrelated existing fixtures alone.

**Keep the workflow-driving code beside the replay tests.** It is the executable
record of arguments, signals, updates, activities, and converter/interceptor setup.
Use `testWorkflowHistory` from `packages/test/src/helpers-history.ts`: it registers
one replay test by default, without starting a server or writing files.
With `TEMPORAL_CAPTURE_HISTORY=<sdk-version>`, it instead starts a local test worker,
runs your callback, and saves the returned history to the configured filename.
Each registration handles one history; register separate tests for other scenarios.
Captures run serially, each driving a fresh workflow independently.
Put the behavior being preserved in the test's title or comments.
See `packages/test/src/test-replay.ts` for a complete example.

```ts
testWorkflowHistory({
  title: 'myWorkflow completes',
  sdkVersion: '1.24.0',
  filename: 'my-workflow-completion-sdk-1.24.0.json',
  workflowsPath: require.resolve('./workflows'),
  async generate(client, taskQueue) {
    const handle = await client.workflow.start(myWorkflow, {
      taskQueue,
      workflowId: randomUUID(),
      workflowExecutionTimeout: '2m',
      args: [],
    });
    await handle.result();
    return await handle.fetchHistory();
  },
});
```

Import `randomUUID` from `node:crypto` and your workflow from its source. Supply
activities and any data converter via `workerOptions`; the helper shares the
converter between capture and replay. `workflowInterceptorModules` configures
the shared bundle. The callback receives a client and the worker's task queue.
The callback returns a single history, not a filename-to-history map. Capture
intentionally replaces existing fixture files; review the resulting JSON diff.

The checked-in code and histories are the source of truth. Keep secrets and
customer data out.

## Procedure (in this order)

1. **Write the workflow and capture path on the target branch.** Resolve the name
   against `packages/test/src/workflows/`.
   Reuse an existing workflow when appropriate; otherwise add and export one that
   exercises the desired behavior. Write the driver in `packages/test/src/`, using
   `testWorkflowHistory`. Drive the actual inputs/signals/updates and await the
   intended outcome inside `generate`, then return the history for that scenario.
   The helper owns serialization and replay with the same bundle and converter.

   Gate capture on an explicit SDK version, e.g. `TEMPORAL_CAPTURE_HISTORY=1.24.0`.
   The helper checks that version against the worker package before starting a
   server or writing anything. Do not generate an old-version fixture on the
   current SDK. Keep the callback after adding replay.

2. **Move that code to the requested SDK checkout.** Prefer a separate checkout
   at the tag, e.g. `v1.24.0`. Copy the test and any new workflow dependencies or
   cherry-pick a focused commit—not the SDK fix, current manifests, or lockfile.
   Include `helpers-history.ts` if the requested tag does not already contain it.
   Reuse activities and helpers already present at the tag. Read its contributor
   and agent instructions. Verify `git rev-parse HEAD` against
   `git rev-parse v1.24.0^{commit}` and check workspace package versions.

   Agents must use an attached checkout. An isolated subagent may use its own
   attached worktree: save copies under ignored `.test-results/`, record the
   original HEAD, and preserve inherited dirty/untracked files with a named stash
   before switching to the tag. Restore the original HEAD and stash afterward;
   never reset or discard inherited changes. Ask for attachment before editing
   an unattached checkout.

3. **Build the old checkout with pnpm and its pinned Core.** Follow that version's
   `CONTRIBUTING.md`. Typical commands:

   ```sh
   git submodule update --init --recursive
   pnpm install --frozen-lockfile
   pnpm build
   ```

   After switching SDK versions, use `pnpm run rebuild` to replace generated/native
   output. Use `run` explicitly: `pnpm rebuild` invokes pnpm's built-in command,
   not the repository script. Do not update Core or dependencies, install published
   Temporal packages over the workspace, or reuse current-version build output.
   Report setup blockers rather than substituting another version/project.

4. **Run capture on the old SDK, then inspect the JSON.** For the smorgasbord
   example, from the old checkout's root:

   ```sh
   TEMPORAL_CAPTURE_HISTORY=1.24.0 RUN_INTEGRATION_TESTS=true \
     pnpm ava lib/test-replay.js --match '*capture smorgasbord*'
   ```

   Use a disposable local test server, a unique task queue, and a bounded timeout.
   Clean up resources you started. Verify the test actually ran, the files exist,
   and their terminal events are correct.
   For Continue-As-New, `handle.result()` follows the chain: save
   `handle.firstExecutionRunId`, fetch each relevant run with a run-pinned handle,
   and follow `workflowExecutionContinuedAsNewEventAttributes.newExecutionRunId`.
   Select and return only the run for the test's scenario. Other runs belong in
   separate tests, even if each capture repeats the workflow execution.

5. **Bring the JSON back and run current-SDK replay.** Do not copy old build output,
   lockfiles, SDK implementation, or native bridge. Keep the opt-in driver, but
   unset `TEMPORAL_CAPTURE_HISTORY` so normal tests replay without writing files.
   Rebuild according to the target branch's contributor instructions, then run:

   ```sh
   pnpm exec tsc --build packages/test/tsconfig.json
   pnpm ava lib/test-replay.js --match '*smorgasbord*'
   ```

   Substitute the actual test file/title for other workflows. Replay needs no
   server. Run relevant formatting/lint and `git diff --check`. Report validation
   results in the PR or conversation. If replay fails, preserve the history;
   do not alter events or workflow behavior to hide it.
