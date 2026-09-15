import { randomUUID } from 'node:crypto';
import { closeSync, openSync, writeSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'ava';

const START_HOOK = '__temporal_ci_observer_start__';
const END_HOOK = '__temporal_ci_observer_end__';

function observedTitle(title: string, hook: string): string | undefined {
  const prefix = `${hook} for `;
  return title.startsWith(prefix) ? title.slice(prefix.length) : undefined;
}

function install(resultsDirectory: string, runId: string, repositoryRoot: string): void {
  let descriptor: number | undefined;
  let disabled = false;

  try {
    const workerId = randomUUID();
    const file = relative(repositoryRoot, fileURLToPath(test.meta.file)).replaceAll('\\', '/');
    const fileStarted = performance.now();
    const activeCases = new Map<string, { caseId: string; started: number }>();
    descriptor = openSync(join(resultsDirectory, `ava-observer-${runId}-${workerId}.jsonl`), 'ax');

    const emit = (event: Record<string, unknown>): void => {
      if (disabled || descriptor === undefined) return;
      try {
        writeSync(
          descriptor,
          `${JSON.stringify({ schemaVersion: 1, runId, workerId, wallTimeMs: Date.now(), file, ...event })}\n`
        );
      } catch (error) {
        disabled = true;
        try {
          closeSync(descriptor);
          process.stderr.write(
            `[ava-ci-observer] disabled: ${error instanceof Error ? error.message : String(error)}\n`
          );
        } catch {
          // Observability must never affect the test process.
        }
        descriptor = undefined;
      }
    };

    emit({ event: 'file-start' });
    test.beforeEach(START_HOOK, (t) => {
      const title = observedTitle(t.title, START_HOOK);
      if (title === undefined) return;
      const active = { caseId: randomUUID(), started: performance.now() };
      activeCases.set(title, active);
      emit({ event: 'case-start', caseId: active.caseId, title });
    });
    test.afterEach.always(END_HOOK, (t) => {
      const title = observedTitle(t.title, END_HOOK);
      if (title === undefined) return;
      const active = activeCases.get(title);
      if (active === undefined) return;
      activeCases.delete(title);
      emit({ event: 'case-end', caseId: active.caseId, title, durationMs: performance.now() - active.started });
    });
    process.once('exit', () => {
      emit({ event: 'file-end', durationMs: performance.now() - fileStarted });
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // The event was already written and the process is exiting.
        }
      }
    });
  } catch (error) {
    disabled = true;
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Observer setup has already failed.
      }
    }
    try {
      process.stderr.write(`[ava-ci-observer] disabled: ${error instanceof Error ? error.message : String(error)}\n`);
    } catch {
      // Observability must never affect the test process.
    }
  }
}

const resultsDirectory = process.env.TEST_RESULTS_DIR;
const runId = process.env.TEMPORAL_AVA_OBSERVER_RUN_ID;
const repositoryRoot = process.env.TEMPORAL_AVA_OBSERVER_ROOT;
if (resultsDirectory && runId && repositoryRoot) install(resultsDirectory, runId, repositoryRoot);
