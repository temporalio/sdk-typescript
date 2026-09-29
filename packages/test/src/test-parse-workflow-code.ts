import test from 'ava';
import { bundleWorkflowCode } from '@temporalio/worker';
import { parseWorkflowCode } from '@temporalio/worker/lib/worker';

test('parseWorkflowCode does not format stack traces for errors thrown while preloading the bundle', async (t) => {
  const bundle = await bundleWorkflowCode({ workflowsPath: require.resolve('./workflows/success-string') });

  // Tools such as source-map-support format stack traces through this hook and cache the bundle's source map when they
  // see one of its frames, keeping the map alive for the lifetime of the process.
  const formattedFiles = new Set<string>();
  const original = Error.prepareStackTrace;
  Error.prepareStackTrace = (err, frames) => {
    for (const frame of frames) {
      const file = frame.getFileName();
      if (file) formattedFiles.add(file);
    }
    return original ? original(err, frames) : `${err}\n${frames.map((f) => `    at ${f}`).join('\n')}`;
  };
  let filename: string;
  try {
    ({ filename } = parseWorkflowCode(bundle.code));
  } finally {
    Error.prepareStackTrace = original;
  }

  t.false(formattedFiles.has(filename));
});
