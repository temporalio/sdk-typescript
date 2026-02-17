import type { TestBatchResult, TestFile } from './types';

// AVA's TAP output uses ' › ' (U+203A) as the separator between file and test title
const SEPARATOR = ' \u203a ';

type Directive = 'skip' | 'todo' | undefined;

interface AssertLine {
  ok: boolean;
  // undefined when AVA omits the file prefix (single-file runs)
  file: string | undefined;
  title: string;
  directive: Directive;
}

// TAP directives appear as "# SKIP" or "# TODO" (case-insensitive) at end of line
const DIRECTIVE_RE = /\s+#\s+(SKIP|TODO)(.*)$/i;

function parseAssertLine(line: string): AssertLine | undefined {
  const match = line.match(/^(not ok|ok)\s+\d+\s+-\s+(.+)$/);
  if (!match) return undefined;

  const ok = match[1] === 'ok';
  let fullName = match[2]!;

  let directive: Directive;
  const directiveMatch = fullName.match(DIRECTIVE_RE);
  if (directiveMatch) {
    directive = directiveMatch[1]!.toLowerCase() as 'skip' | 'todo';
    fullName = fullName.slice(0, directiveMatch.index);
  }

  const sepIdx = fullName.indexOf(SEPARATOR);
  if (sepIdx === -1) {
    // AVA omits the file prefix when running a single file
    return { ok, file: undefined, title: fullName, directive };
  }
  return {
    ok,
    file: fullName.slice(0, sepIdx),
    title: fullName.slice(sepIdx + SEPARATOR.length),
    directive,
  };
}

export function parseTapOutput(output: string, expectedFiles: TestFile[]): TestBatchResult {
  const fileResults = new Map<TestFile, { seen: boolean; hasFailed: boolean; failedTitles: string[] }>();

  for (const file of expectedFiles) {
    fileResults.set(file, { seen: false, hasFailed: false, failedTitles: [] });
  }

  for (const line of output.split('\n')) {
    const assert = parseAssertLine(line.trim());
    if (!assert) continue;

    // When AVA runs a single file it omits the file prefix;
    // attribute all assertions to the sole expected file.
    const file =
      assert.file !== undefined
        ? resolveFile(assert.file, expectedFiles)
        : expectedFiles.length === 1
          ? expectedFiles[0]
          : undefined;
    if (!file) continue;

    let result = fileResults.get(file);
    if (!result) {
      result = { seen: false, hasFailed: false, failedTitles: [] };
      fileResults.set(file, result);
    }

    result.seen = true;
    // skip, todo, and "no tests found" assertions are not real failures
    if (!assert.ok && !assert.directive && !isNoTestsFound(assert.title)) {
      result.hasFailed = true;
      if (assert.title) {
        result.failedTitles.push(assert.title);
      }
    }
  }

  const passed: TestFile[] = [];
  const failed: TestFile[] = [];
  const failureDetails: Record<TestFile, string[]> = {};

  for (const [file, result] of fileResults) {
    // Files with no output are treated as failures (crashed before tests ran)
    if (result.seen && !result.hasFailed) {
      passed.push(file);
    } else {
      failed.push(file);
      failureDetails[file] = result.failedTitles;
    }
  }

  return { passed, failed, failureDetails };
}

// AVA emits "No tests found in $FILE" when all tests in a file are
// conditionally skipped at registration time (e.g. platform guards).
function isNoTestsFound(title: string): boolean {
  return title.startsWith('No tests found in ');
}

function resolveFile(tapName: string, expectedFiles: TestFile[]): TestFile | undefined {
  for (const file of expectedFiles) {
    // AVA strips the directory, the "test-" prefix, and the extension in TAP output.
    // e.g. "lib/test-time.js" becomes "time", "lib/test-enums-helpers.js" becomes "enums-helpers"
    const shortName = file.replace(/^.*\/test-/, '').replace(/\.js$/, '');
    if (shortName === tapName) {
      return file;
    }
    // Also try full path without extension and exact match
    const withoutExt = file.replace(/\.js$/, '');
    if (withoutExt === tapName || file === tapName) {
      return file;
    }
  }
  return undefined;
}
