import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface TimingEnvironment {
  id: string;
  label: string;
  jobUrl: string | null;
  completedAtMs: number | null;
}

interface TimingEvent {
  schemaVersion: 1;
  runId: string;
  workerId: string;
  wallTimeMs: number;
  file: string;
  event: 'file-start' | 'file-end' | 'case-start' | 'case-end';
  caseId?: string;
  title?: string;
  durationMs?: number;
}

interface Observation {
  file: string;
  durationMs: number;
}

interface CaseObservation extends Observation {
  caseId: string;
  title: string;
}

export interface TimingSnapshot {
  files: Observation[];
  cases: CaseObservation[];
  activeFiles: Array<{ workerId: string; file: string; elapsedMs: number }>;
  activeCases: Array<{ workerId: string; file: string; title: string; elapsedMs: number }>;
  lastCompleted: { file: string; title: string } | null;
}

export interface TimingRun {
  environment: TimingEnvironment;
  snapshot: TimingSnapshot;
}

const LIMIT = 10;

function filesUnder(directory: string, extension: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  try {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) files.push(...filesUnder(path, extension));
      else if (entry.endsWith(extension)) files.push(path);
    }
  } catch {
    // Missing or partially downloaded artifacts should not break the CI summary.
  }
  return files;
}

function parseEvent(line: string): TimingEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const event = value as Partial<TimingEvent>;
  if (
    event.schemaVersion !== 1 ||
    typeof event.runId !== 'string' ||
    typeof event.workerId !== 'string' ||
    typeof event.wallTimeMs !== 'number' ||
    typeof event.file !== 'string' ||
    !['file-start', 'file-end', 'case-start', 'case-end'].includes(String(event.event))
  ) {
    return null;
  }
  return event as TimingEvent;
}

function readEvents(directory: string, runId?: string): TimingEvent[] {
  const events: TimingEvent[] = [];
  for (const file of filesUnder(directory, '.jsonl')) {
    let contents = '';
    try {
      contents = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of contents.split('\n')) {
      const event = parseEvent(line);
      if (event && (runId === undefined || event.runId === runId)) events.push(event);
    }
  }
  return events.sort((left, right) => left.wallTimeMs - right.wallTimeMs);
}

export function readTimingDirectory(directory: string, referenceMs = Date.now(), runId?: string): TimingSnapshot {
  const fileStarts = new Map<string, TimingEvent>();
  const caseStarts = new Map<string, TimingEvent>();
  const files: Observation[] = [];
  const cases: CaseObservation[] = [];
  let lastCompleted: TimingSnapshot['lastCompleted'] = null;

  for (const event of readEvents(directory, runId)) {
    if (event.event === 'file-start') fileStarts.set(event.workerId, event);
    if (
      event.event === 'file-end' &&
      fileStarts.has(event.workerId) &&
      typeof event.durationMs === 'number' &&
      event.durationMs >= 0
    ) {
      files.push({ file: event.file, durationMs: event.durationMs });
      fileStarts.delete(event.workerId);
    }
    if (event.event === 'case-start' && event.caseId && event.title) caseStarts.set(event.caseId, event);
    const start = event.caseId ? caseStarts.get(event.caseId) : undefined;
    if (event.event === 'case-end' && start?.title && typeof event.durationMs === 'number' && event.durationMs >= 0) {
      cases.push({ caseId: event.caseId!, file: start.file, title: start.title, durationMs: event.durationMs });
      caseStarts.delete(event.caseId!);
      lastCompleted = { file: start.file, title: start.title };
    }
  }

  return {
    files,
    cases,
    activeFiles: [...fileStarts.values()].map((event) => ({
      workerId: event.workerId,
      file: event.file,
      elapsedMs: Math.max(0, referenceMs - event.wallTimeMs),
    })),
    activeCases: [...caseStarts.values()].map((event) => ({
      workerId: event.workerId,
      file: event.file,
      title: event.title!,
      elapsedMs: Math.max(0, referenceMs - event.wallTimeMs),
    })),
    lastCompleted,
  };
}

function fallbackEnvironment(id: string): TimingEnvironment {
  const match = /^(.*)-(\d+|bun)-(reuse|noreuse)$/.exec(id);
  const label = match
    ? `${match[1]} · ${match[2] === 'bun' ? 'Bun' : `Node ${match[2]}`} · ${
        match[3] === 'reuse' ? 'reuse' : 'no reuse'
      }`
    : id;
  return { id, label, jobUrl: null, completedAtMs: null };
}

export function collectTimingRuns(
  artifactRoot: string,
  environments: ReadonlyMap<string, TimingEnvironment>
): TimingRun[] {
  if (!existsSync(artifactRoot)) return [];
  const runs: TimingRun[] = [];
  for (const artifact of readdirSync(artifactRoot)) {
    if (!artifact.startsWith('test-logs-')) continue;
    const directory = join(artifactRoot, artifact);
    if (!statSync(directory).isDirectory()) continue;
    const environmentId = artifact.slice('test-logs-'.length);
    const environment = environments.get(environmentId) ?? fallbackEnvironment(environmentId);
    const references = new Map<string, number | null>();

    for (const event of readEvents(directory)) references.set(event.runId, references.get(event.runId) ?? null);
    for (const file of filesUnder(directory, '.json')) {
      try {
        const result = JSON.parse(readFileSync(file, 'utf8'));
        if (typeof result.observerRunId === 'string') {
          references.set(result.observerRunId, typeof result.finishedAtMs === 'number' ? result.finishedAtMs : null);
        }
      } catch {
        // Ignore unrelated or incomplete result files.
      }
    }

    for (const [runId, finishedAtMs] of references) {
      const snapshot = readTimingDirectory(directory, finishedAtMs ?? environment.completedAtMs ?? Date.now(), runId);
      if (
        snapshot.files.length ||
        snapshot.cases.length ||
        snapshot.activeFiles.length ||
        snapshot.activeCases.length
      ) {
        runs.push({ environment, snapshot });
      }
    }
  }
  return runs;
}

function sourceFile(file: string): string {
  return file.replace('/lib/', '/src/').replace(/\.js$/, '.ts');
}

function clean(value: string): string {
  const text = value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (text.length > 160 ? `${text.slice(0, 159)}…` : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|');
}

function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  return seconds < 60
    ? `${seconds.toFixed(1)}s`
    : `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)
        .toString()
        .padStart(2, '0')}s`;
}

interface Attributed<T extends Observation> {
  observation: T;
  environment: TimingEnvironment;
}

function linked(value: Attributed<Observation>): string {
  const label = `${duration(value.observation.durationMs)} · ${clean(value.environment.label)}`;
  return value.environment.jobUrl ? `[${label}](${value.environment.jobUrl})` : label;
}

function statistics<T extends Observation>(values: Array<Attributed<T>>) {
  const sorted = [...values].sort((a, b) => a.observation.durationMs - b.observation.durationMs);
  const lower = sorted[Math.floor((sorted.length - 1) / 2)];
  const upper = sorted[Math.floor(sorted.length / 2)];
  return {
    median:
      lower === upper
        ? linked(lower)
        : `${duration((lower.observation.durationMs + upper.observation.durationMs) / 2)} between ${linked(
            lower
          )} / ${linked(upper)}`,
    fastest: linked(sorted[0]),
    slowest: linked(sorted[sorted.length - 1]),
    count: sorted.length,
    medianMs: (lower.observation.durationMs + upper.observation.durationMs) / 2,
  };
}

function grouped<T extends Observation>(values: Array<Attributed<T>>, key: (value: T) => string) {
  const groups = new Map<string, Array<Attributed<T>>>();
  for (const value of values)
    groups.set(key(value.observation), [...(groups.get(key(value.observation)) ?? []), value]);
  return [...groups.entries()]
    .map(([groupKey, observations]) => ({ key: groupKey, observations, stats: statistics(observations) }))
    .sort((a, b) => b.stats.medianMs - a.stats.medianMs)
    .slice(0, LIMIT);
}

export function renderTimingSummary(runs: readonly TimingRun[]): string[] {
  const fileValues = runs.flatMap((run) =>
    run.snapshot.files.map((observation) => ({ observation, environment: run.environment }))
  );
  const caseValues = runs.flatMap((run) =>
    run.snapshot.cases.map((observation) => ({ observation, environment: run.environment }))
  );
  const lines = ['## Test timing', ''];

  const fileGroups = grouped(fileValues, (value) => sourceFile(value.file));
  if (fileGroups.length) {
    lines.push(
      '### Slowest test files',
      '',
      '| File | Median | Fastest | Slowest | Job runs |',
      '| --- | --- | --- | --- | ---: |',
      ...fileGroups.map(
        ({ key, stats }) =>
          `| \`${clean(key)}\` | ${stats.median} | ${stats.fastest} | ${stats.slowest} | ${stats.count} |`
      ),
      ''
    );
  }

  const caseGroups = grouped(caseValues, (value) => `${sourceFile(value.file)}\0${value.title}`);
  if (caseGroups.length) {
    lines.push(
      '### Slowest observed tests',
      '',
      '| Test | File | Median | Fastest | Slowest | Job runs |',
      '| --- | --- | --- | --- | --- | ---: |',
      ...caseGroups.map(({ observations, stats }) => {
        const value = observations[0].observation;
        return `| ${clean(value.title)} | \`${clean(sourceFile(value.file))}\` | ${stats.median} | ${stats.fastest} | ${
          stats.slowest
        } | ${stats.count} |`;
      }),
      ''
    );
  }

  const active = runs.flatMap((run) => {
    const workersWithCases = new Set(run.snapshot.activeCases.map((value) => value.workerId));
    const values = run.snapshot.activeCases.map((value) => ({
      ...value,
      environment: run.environment,
      lastCompleted: run.snapshot.lastCompleted,
    }));
    return values.concat(
      run.snapshot.activeFiles
        .filter((value) => !workersWithCases.has(value.workerId))
        .map((value) => ({
          ...value,
          title: 'file active; no test observed',
          environment: run.environment,
          lastCompleted: run.snapshot.lastCompleted,
        }))
    );
  });
  if (active.length) {
    lines.push(
      '### Active at termination',
      '',
      '| Job | File | Active | Elapsed | Last completed |',
      '| --- | --- | --- | ---: | --- |',
      ...active
        .sort((a, b) => b.elapsedMs - a.elapsedMs)
        .slice(0, LIMIT)
        .map((value) => {
          const job = value.environment.jobUrl
            ? `[${clean(value.environment.label)}](${value.environment.jobUrl})`
            : clean(value.environment.label);
          const last = value.lastCompleted
            ? `${clean(value.lastCompleted.title)} (\`${clean(sourceFile(value.lastCompleted.file))}\`)`
            : '—';
          return `| ${job} | \`${clean(sourceFile(value.file))}\` | ${clean(value.title)} | ${duration(
            value.elapsedMs
          )} | ${last} |`;
        }),
      '',
      '_Active observations identify unfinished work, not necessarily the cause of the failure._',
      ''
    );
  }

  if (!fileGroups.length && !caseGroups.length) lines.push('No completed timing observations were available.', '');
  lines.push(
    '_Observed test time spans the observer beforeEach through afterEach.always, includes per-test hooks, excludes file hooks, and may overlap other tests._',
    ''
  );
  return lines;
}

export function formatTimingHeartbeat(snapshot: TimingSnapshot): string | null {
  const parts: string[] = [];
  const active = snapshot.activeCases[0];
  if (active) parts.push(`active: ${sourceFile(active.file)} › ${active.title} (${duration(active.elapsedMs)})`);
  const file = snapshot.activeFiles[0];
  if (!active && file) parts.push(`active file: ${sourceFile(file.file)} (${duration(file.elapsedMs)})`);
  if (snapshot.lastCompleted) {
    parts.push(`last completed: ${sourceFile(snapshot.lastCompleted.file)} › ${snapshot.lastCompleted.title}`);
  }
  return parts.length ? parts.join('; ') : null;
}
