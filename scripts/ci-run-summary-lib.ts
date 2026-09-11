import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface Failure {
  title: string;
  message: string;
  at: string;
  diagnostic: string;
}

export interface PackageResult {
  package: string;
  fail: number;
  exitCode: number;
  durationMs: number;
  failures: Failure[];
}

export interface PackageObservation {
  cellId: string;
  cellLabel: string;
  result: PackageResult;
}

export interface WorkflowStep {
  name: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface WorkflowJob {
  name: string;
  htmlUrl: string | null;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  steps: WorkflowStep[];
}

export interface SummaryRow {
  jobLabel: string;
  jobUrl: string | null;
  type: string;
  test: string;
}

export interface SummaryReport {
  executionSpanMs: number | null;
  markdown: string;
  passed: boolean;
  rows: SummaryRow[];
  slowestJob: { name: string; durationMs: number } | null;
  status: 'passed' | 'failed' | 'incomplete';
  verdict: string;
}

type Needs = Record<string, { result?: string }>;

interface Cell {
  id: string;
  label: string;
  conclusion: string | null;
  htmlUrl: string | null;
}

interface TimedJob {
  job: WorkflowJob;
  startedAtMs: number;
  completedAtMs: number;
  durationMs: number;
}

interface TimedStep {
  job: WorkflowJob;
  step: WorkflowStep;
  durationMs: number;
}

const JOB_LABELS: Record<string, string> = {
  'compile-native-binaries-debug': 'Compile Native Binaries',
  'integration-tests': 'Integration Tests',
  'cloud-integration-tests': 'Cloud Integration Tests',
  conventions: 'Lint & Prune',
  'features-tests': 'Features Tests',
  'stress-tests-no-reuse-context': 'Stress Tests (no reuse)',
  'stress-tests-reuse-context': 'Stress Tests (reuse)',
  docs: 'Build Docs',
};

const VISIBLE_TIMING_ROWS = 5;
const DETAIL_TIMING_ROWS = 20;
const TIMELINE_WIDTH = 40;
const TIMELINE_LABEL_WIDTH = 42;
const MAX_TIMELINE_JOBS = 40;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function finiteNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function cleanInline(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(value: string, length: number): string {
  if (value.length <= length) return value;
  return `${value.slice(0, Math.max(0, length - 1))}…`;
}

function escapeTable(value: string): string {
  return cleanInline(value).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

function escapeLinkLabel(value: string): string {
  return escapeTable(value).replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

function jobLink(label: string, url: string | null): string {
  const escaped = escapeLinkLabel(label);
  return url ? `[${escaped}](${url})` : escaped;
}

function codeBlockLabel(value: string): string {
  return cleanInline(value).replace(/`/g, "'");
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const roundedSeconds = Math.round(seconds);
  const minutes = Math.floor(roundedSeconds / 60);
  const remainingSeconds = roundedSeconds % 60;
  return `${minutes}m${remainingSeconds.toString().padStart(2, '0')}s`;
}

function parseTimestamp(value: string | null): number | null {
  if (value == null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeStep(value: unknown): WorkflowStep | null {
  if (!isRecord(value) || typeof value.name !== 'string') return null;
  return {
    name: value.name,
    startedAt: nullableString(value.started_at),
    completedAt: nullableString(value.completed_at),
  };
}

function normalizeJob(value: unknown): WorkflowJob | null {
  if (!isRecord(value) || typeof value.name !== 'string') return null;
  return {
    name: value.name,
    htmlUrl: nullableString(value.html_url),
    conclusion: nullableString(value.conclusion),
    startedAt: nullableString(value.started_at),
    completedAt: nullableString(value.completed_at),
    steps: Array.isArray(value.steps) ? value.steps.map(normalizeStep).filter((step) => step !== null) : [],
  };
}

/** Parse either one jobs API response or the array emitted by `gh api --paginate --slurp`. */
export function parseWorkflowJobsJson(raw: string): WorkflowJob[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const pages = Array.isArray(parsed) ? parsed : [parsed];
  const jobs: WorkflowJob[] = [];
  for (const page of pages) {
    if (!isRecord(page) || !Array.isArray(page.jobs)) continue;
    for (const value of page.jobs) {
      const job = normalizeJob(value);
      if (job !== null) jobs.push(job);
    }
  }
  return jobs;
}

export function parseNeedsJson(raw: string | undefined): Needs {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    const needs: Needs = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (isRecord(value)) needs[key] = { result: nullableString(value.result) ?? undefined };
    }
    return needs;
  } catch {
    return {};
  }
}

function findJsonFiles(directory: string): string[] {
  const files: string[] = [];
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const path = join(directory, entry);
    let isDirectory = false;
    try {
      isDirectory = statSync(path).isDirectory();
    } catch {
      continue;
    }
    if (isDirectory) files.push(...findJsonFiles(path));
    else if (entry.endsWith('.json')) files.push(path);
  }
  return files;
}

function normalizeFailure(value: unknown): Failure | null {
  if (!isRecord(value) || typeof value.title !== 'string') return null;
  return {
    title: value.title,
    message: typeof value.message === 'string' ? value.message : '',
    at: typeof value.at === 'string' ? value.at : '',
    diagnostic: typeof value.diagnostic === 'string' ? value.diagnostic : '',
  };
}

function normalizePackageResult(value: unknown): PackageResult | null {
  if (!isRecord(value) || typeof value.package !== 'string') return null;
  const durationMs = finiteNonNegativeNumber(value.durationMs);
  if (durationMs === null) return null;
  return {
    package: value.package,
    fail: finiteNonNegativeNumber(value.fail) ?? 0,
    exitCode: finiteNonNegativeNumber(value.exitCode) ?? 0,
    durationMs,
    failures: Array.isArray(value.failures)
      ? value.failures.map(normalizeFailure).filter((failure) => failure !== null)
      : [],
  };
}

function fallbackCellLabel(cellId: string): string {
  const match = /^(.*)-(\d+|bun)-(reuse|noreuse)$/.exec(cellId);
  if (!match) return cellId;
  const [, platform, runtime, reuse] = match;
  const runtimeLabel = runtime === 'bun' ? 'Bun (non-blocking)' : `Node ${runtime}`;
  return `${platform} · ${runtimeLabel} · ${reuse === 'reuse' ? 'reuse' : 'no reuse'}`;
}

export function collectPackageObservations(root: string): PackageObservation[] {
  if (!existsSync(root)) return [];
  let artifactNames;
  try {
    artifactNames = readdirSync(root);
  } catch {
    return [];
  }
  const observations: PackageObservation[] = [];
  for (const artifactName of artifactNames) {
    const directory = join(root, artifactName);
    try {
      if (!statSync(directory).isDirectory()) continue;
    } catch {
      continue;
    }
    const cellId = artifactName.replace(/^test-logs-/, '');
    for (const file of findJsonFiles(directory)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      const result = normalizePackageResult(parsed);
      if (result === null) continue;
      observations.push({ cellId, cellLabel: fallbackCellLabel(cellId), result });
    }
  }
  return observations;
}

function integrationCell(job: WorkflowJob): Cell | null {
  const match = /^Run Integration Tests \((.+), (Node \d+|Bun), Reuse V8 Context (true|false)\)$/.exec(job.name);
  if (!match) return null;
  const [, platform, runtimePart, reusePart] = match;
  const runtime = runtimePart === 'Bun' ? 'bun' : runtimePart.replace(/^Node /, '');
  const reuse = reusePart === 'true' ? 'reuse' : 'noreuse';
  const runtimeLabel = runtime === 'bun' ? 'Bun (non-blocking)' : `Node ${runtime}`;
  return {
    id: `${platform}-${runtime}-${reuse}`,
    label: `${platform} · ${runtimeLabel} · ${reuse === 'reuse' ? 'reuse' : 'no reuse'}`,
    conclusion: job.conclusion,
    htmlUrl: job.htmlUrl,
  };
}

function jobDisplayName(job: WorkflowJob): string {
  const cell = integrationCell(job);
  return cell ? `Tests · ${cell.label}` : job.name;
}

function classify(failure: Failure): string {
  const text = `${failure.title}\n${failure.message}\n${failure.diagnostic}`.toLowerCase();
  if (/no tests found/.test(text)) return 'no tests';
  if (/timed out|timeout|no new tests completed within|exceeded/.test(text)) return 'timeout';
  if (
    /exited with a non-zero exit code|exited due to|process\.exit|uncaught|unhandled rejection|sigsegv|sigabrt|segmentation/.test(
      text
    )
  )
    return 'crashed';
  return 'test failure';
}

function testColumn(pkg: string, failure: Failure): string {
  const packagePrefix = pkg && pkg !== '@temporalio/test' ? `${pkg.replace('@temporalio/', '')}: ` : '';
  const location = failure.at ? ` (${failure.at})` : '';
  const message = failure.message ? ` — ${failure.message}` : '';
  return truncate(cleanInline(`${packagePrefix}${failure.title}${location}${message}`), 320);
}

function timingForJob(job: WorkflowJob): TimedJob | null {
  const startedAtMs = parseTimestamp(job.startedAt);
  const completedAtMs = parseTimestamp(job.completedAt);
  if (startedAtMs === null || completedAtMs === null || completedAtMs < startedAtMs) return null;
  return { job, startedAtMs, completedAtMs, durationMs: completedAtMs - startedAtMs };
}

function completedJobTimings(jobs: readonly WorkflowJob[]): TimedJob[] {
  return jobs.map(timingForJob).filter((timing) => timing !== null);
}

function completedStepTimings(jobs: readonly WorkflowJob[]): TimedStep[] {
  const timings: TimedStep[] = [];
  for (const job of jobs) {
    for (const step of job.steps) {
      const startedAtMs = parseTimestamp(step.startedAt);
      const completedAtMs = parseTimestamp(step.completedAt);
      if (startedAtMs === null || completedAtMs === null || completedAtMs < startedAtMs) continue;
      timings.push({ job, step, durationMs: completedAtMs - startedAtMs });
    }
  }
  return timings;
}

function byDurationThenName<T>(duration: (value: T) => number, name: (value: T) => string): (a: T, b: T) => number {
  return (a, b) => duration(b) - duration(a) || name(a).localeCompare(name(b));
}

function renderTimeline(timings: readonly TimedJob[]): string[] {
  if (timings.length === 0) return [];
  const sorted = [...timings].sort((a, b) => a.startedAtMs - b.startedAtMs || a.job.name.localeCompare(b.job.name));
  const shown = sorted.slice(0, MAX_TIMELINE_JOBS);
  const earliest = Math.min(...sorted.map((timing) => timing.startedAtMs));
  const latest = Math.max(...sorted.map((timing) => timing.completedAtMs));
  const span = Math.max(1, latest - earliest);
  const lines = [`${'Job'.padEnd(TIMELINE_LABEL_WIDTH)}  ${'0s'.padEnd(TIMELINE_WIDTH)}  ${formatDuration(span)}`];
  for (const timing of shown) {
    const start = Math.min(TIMELINE_WIDTH - 1, Math.floor(((timing.startedAtMs - earliest) / span) * TIMELINE_WIDTH));
    const end = Math.min(
      TIMELINE_WIDTH,
      Math.max(start + 1, Math.ceil(((timing.completedAtMs - earliest) / span) * TIMELINE_WIDTH))
    );
    const bar = `${' '.repeat(start)}${'█'.repeat(end - start)}`.padEnd(TIMELINE_WIDTH);
    const label = truncate(codeBlockLabel(jobDisplayName(timing.job)), TIMELINE_LABEL_WIDTH - 1).padEnd(
      TIMELINE_LABEL_WIDTH
    );
    lines.push(`${label}  ${bar}  ${formatDuration(timing.durationMs)}`);
  }
  if (sorted.length > shown.length) lines.push(`… ${sorted.length - shown.length} additional completed jobs omitted`);
  return lines;
}

function renderJobTable(timings: readonly TimedJob[], limit: number, offset = 0): string[] {
  const rows = [...timings]
    .sort(
      byDurationThenName(
        (timing) => timing.durationMs,
        (timing) => timing.job.name
      )
    )
    .slice(offset, offset + limit);
  if (rows.length === 0) return [];
  return [
    '| Job | Duration |',
    '| --- | ---: |',
    ...rows.map(
      ({ job, durationMs }) => `| ${jobLink(jobDisplayName(job), job.htmlUrl)} | ${formatDuration(durationMs)} |`
    ),
  ];
}

function renderStepTable(timings: readonly TimedStep[], limit: number, offset = 0): string[] {
  const rows = [...timings]
    .sort(
      byDurationThenName(
        (timing) => timing.durationMs,
        (timing) => `${timing.job.name}\u0000${timing.step.name}`
      )
    )
    .slice(offset, offset + limit);
  if (rows.length === 0) return [];
  return [
    '| Job | Step | Duration |',
    '| --- | --- | ---: |',
    ...rows.map(
      ({ job, step, durationMs }) =>
        `| ${jobLink(jobDisplayName(job), job.htmlUrl)} | ${escapeTable(step.name)} | ${formatDuration(durationMs)} |`
    ),
  ];
}

function renderPackageTable(
  observations: readonly PackageObservation[],
  cellsById: ReadonlyMap<string, Cell>,
  limit: number,
  offset = 0
): string[] {
  const rows = [...observations]
    .sort(
      byDurationThenName(
        (observation) => observation.result.durationMs,
        (observation) => `${observation.cellId}\u0000${observation.result.package}`
      )
    )
    .slice(offset, offset + limit);
  if (rows.length === 0) return [];
  return [
    '| Matrix cell | Package | Duration |',
    '| --- | --- | ---: |',
    ...rows.map((observation) => {
      const cell = cellsById.get(observation.cellId);
      const label = cell?.label ?? observation.cellLabel;
      return `| ${jobLink(label, cell?.htmlUrl ?? null)} | ${escapeTable(
        observation.result.package
      )} | ${formatDuration(observation.result.durationMs)} |`;
    }),
  ];
}

function appendTimingSection(
  markdown: string[],
  jobs: readonly WorkflowJob[],
  observations: readonly PackageObservation[],
  cellsById: ReadonlyMap<string, Cell>
): { executionSpanMs: number | null; slowestJob: { name: string; durationMs: number } | null } {
  const jobTimings = completedJobTimings(jobs);
  const stepTimings = completedStepTimings(jobs);
  const earliest = jobTimings.length ? Math.min(...jobTimings.map((timing) => timing.startedAtMs)) : null;
  const latest = jobTimings.length ? Math.max(...jobTimings.map((timing) => timing.completedAtMs)) : null;
  const executionSpanMs = earliest !== null && latest !== null ? latest - earliest : null;
  const sortedJobs = [...jobTimings].sort(
    byDurationThenName(
      (timing) => timing.durationMs,
      (timing) => timing.job.name
    )
  );
  const slowestJob = sortedJobs[0] ? { name: sortedJobs[0].job.name, durationMs: sortedJobs[0].durationMs } : null;

  markdown.push('## Timing', '');
  if (executionSpanMs === null) {
    markdown.push('Job timing data was unavailable for this run.', '');
  } else {
    markdown.push(
      `**Execution span:** ${formatDuration(executionSpanMs)} across ${jobTimings.length} completed jobs.`,
      ''
    );
    const timeline = renderTimeline(jobTimings);
    if (timeline.length) markdown.push('```text', ...timeline, '```', '');

    const visibleJobs = renderJobTable(jobTimings, VISIBLE_TIMING_ROWS);
    if (visibleJobs.length) markdown.push('### Slowest jobs', '', ...visibleJobs, '');
    const visibleSteps = renderStepTable(stepTimings, VISIBLE_TIMING_ROWS);
    if (visibleSteps.length) markdown.push('### Slowest steps', '', ...visibleSteps, '');
  }
  const visiblePackages = renderPackageTable(observations, cellsById, VISIBLE_TIMING_ROWS);
  if (visiblePackages.length) markdown.push('### Slowest test package runs', '', ...visiblePackages, '');

  if (
    jobTimings.length > VISIBLE_TIMING_ROWS ||
    stepTimings.length > VISIBLE_TIMING_ROWS ||
    observations.length > VISIBLE_TIMING_ROWS
  ) {
    const additionalRows = DETAIL_TIMING_ROWS - VISIBLE_TIMING_ROWS;
    markdown.push('<details>', '<summary>Additional timing details</summary>', '');
    if (jobTimings.length > VISIBLE_TIMING_ROWS)
      markdown.push('#### Jobs', '', ...renderJobTable(jobTimings, additionalRows, VISIBLE_TIMING_ROWS), '');
    if (stepTimings.length > VISIBLE_TIMING_ROWS)
      markdown.push('#### Steps', '', ...renderStepTable(stepTimings, additionalRows, VISIBLE_TIMING_ROWS), '');
    if (observations.length > VISIBLE_TIMING_ROWS)
      markdown.push(
        '#### Test package runs',
        '',
        ...renderPackageTable(observations, cellsById, additionalRows, VISIBLE_TIMING_ROWS),
        ''
      );
    markdown.push('</details>', '');
  }
  markdown.push(
    '_Durations are current-run observations. Parallel job durations and package runs from different matrix cells are not summed or averaged._',
    ''
  );
  return { executionSpanMs, slowestJob };
}

function nonPassingConclusion(conclusion: string | null): boolean {
  return conclusion === 'failure' || conclusion === 'cancelled' || conclusion === 'timed_out';
}

export function buildSummary(
  needs: Needs,
  jobs: readonly WorkflowJob[],
  observations: readonly PackageObservation[]
): SummaryReport {
  const topLevel = Object.entries(needs).map(([id, value]) => ({
    id,
    label: JOB_LABELS[id] ?? id,
    result: value.result ?? 'unknown',
  }));
  const hasNeeds = topLevel.length > 0;
  const anyFailed = hasNeeds
    ? topLevel.some((job) => job.result === 'failure')
    : jobs.some((job) => job.conclusion === 'failure' || job.conclusion === 'timed_out');
  const anyCancelled = hasNeeds
    ? topLevel.some((job) => job.result === 'cancelled')
    : jobs.some((job) => job.conclusion === 'cancelled');
  const passed = !anyFailed && !anyCancelled;
  const status: SummaryReport['status'] = passed ? 'passed' : anyFailed ? 'failed' : 'incomplete';
  const cells = jobs.map(integrationCell).filter((cell) => cell !== null);
  const cellsById = new Map(cells.map((cell) => [cell.id, cell]));
  const failuresByCell = new Map<string, Array<{ pkg: string; failure: Failure }>>();
  for (const observation of observations) {
    if (observation.result.fail === 0 && observation.result.exitCode === 0) continue;
    const failures = failuresByCell.get(observation.cellId) ?? [];
    if (observation.result.failures.length) {
      for (const failure of observation.result.failures) failures.push({ pkg: observation.result.package, failure });
    } else {
      failures.push({
        pkg: observation.result.package,
        failure: {
          title: `${observation.result.fail || '?'} failed (see job log)`,
          message: '',
          at: '',
          diagnostic: '',
        },
      });
    }
    failuresByCell.set(observation.cellId, failures);
  }

  const rows: SummaryRow[] = [];
  let integrationFailed = 0;
  let integrationCancelled = 0;
  const integrationJobNames = new Set<string>();
  if (cells.length) {
    for (const cell of [...cells].sort((a, b) => a.label.localeCompare(b.label))) {
      const matchingJob = jobs.find((job) => integrationCell(job)?.id === cell.id);
      if (matchingJob) integrationJobNames.add(matchingJob.name);
      if (cell.conclusion === 'success' || cell.conclusion === 'skipped' || cell.conclusion === null) continue;
      if (cell.conclusion === 'cancelled' || cell.conclusion === 'timed_out') {
        integrationCancelled++;
        rows.push({
          jobLabel: cell.label,
          jobUrl: cell.htmlUrl,
          type: cell.conclusion === 'timed_out' ? 'timed out' : 'cancelled',
          test: 'did not finish',
        });
        continue;
      }
      integrationFailed++;
      const failures = failuresByCell.get(cell.id);
      if (failures?.length) {
        for (const { pkg, failure } of failures) {
          rows.push({
            jobLabel: cell.label,
            jobUrl: cell.htmlUrl,
            type: classify(failure),
            test: testColumn(pkg, failure),
          });
        }
      } else {
        rows.push({
          jobLabel: cell.label,
          jobUrl: cell.htmlUrl,
          type: 'no results',
          test: 'no test results captured — open the job log',
        });
      }
    }
  } else {
    for (const [cellId, failures] of [...failuresByCell.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      integrationFailed++;
      const label = observations.find((observation) => observation.cellId === cellId)?.cellLabel ?? cellId;
      for (const { pkg, failure } of failures) {
        rows.push({ jobLabel: label, jobUrl: null, type: classify(failure), test: testColumn(pkg, failure) });
      }
    }
  }

  for (const job of jobs) {
    if (!nonPassingConclusion(job.conclusion) || integrationJobNames.has(job.name)) continue;
    rows.push({
      jobLabel: job.name,
      jobUrl: job.htmlUrl,
      type: job.conclusion === 'timed_out' ? 'timed out' : job.conclusion ?? 'unknown',
      test: 'open the job log for details',
    });
  }

  const otherFailing = topLevel
    .filter((job) => job.result === 'failure' && job.id !== 'integration-tests')
    .map((job) => job.label);
  const otherCancelled = topLevel
    .filter((job) => job.result === 'cancelled' && job.id !== 'integration-tests')
    .map((job) => job.label);
  const verdictParts: string[] = [];
  if (integrationFailed || integrationCancelled) {
    const bits: string[] = [];
    if (integrationFailed) bits.push(`${integrationFailed} failed`);
    if (integrationCancelled) bits.push(`${integrationCancelled} incomplete`);
    verdictParts.push(`**Integration Tests** — ${bits.join(', ')}`);
  } else if (needs['integration-tests']?.result === 'failure') {
    verdictParts.push('**Integration Tests** failed');
  } else if (needs['integration-tests']?.result === 'cancelled') {
    verdictParts.push('**Integration Tests** cancelled');
  }
  for (const label of otherFailing) verdictParts.push(`**${label}** failed`);
  for (const label of otherCancelled) verdictParts.push(`**${label}** cancelled`);
  const verdict = passed
    ? 'All checks passed.'
    : verdictParts.length
      ? `${verdictParts.join('; ')}.`
      : anyCancelled
        ? 'Some checks were cancelled and did not complete.'
        : 'One or more checks failed.';

  const markdown: string[] = [
    `# ${status === 'passed' ? '✅ Passed' : status === 'failed' ? '❌ Failed' : '⚪ Incomplete'}`,
    '',
    verdict,
    '',
  ];
  if (rows.length) {
    markdown.push('| Job | Type | Failure |', '| --- | --- | --- |');
    for (const row of rows) {
      markdown.push(`| ${jobLink(row.jobLabel, row.jobUrl)} | ${escapeTable(row.type)} | ${escapeTable(row.test)} |`);
    }
    markdown.push('', 'Full output is available from the linked job logs and `test-logs-*` artifacts.', '');
  }
  const { executionSpanMs, slowestJob } = appendTimingSection(markdown, jobs, observations, cellsById);
  return {
    executionSpanMs,
    markdown: markdown.join('\n').trimEnd() + '\n',
    passed,
    rows,
    slowestJob,
    status,
    verdict,
  };
}
