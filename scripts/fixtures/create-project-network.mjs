import dns from 'node:dns';
import { register, syncBuiltinESMExports } from 'node:module';

// The harness captures child output; explicitly exercise the terminal-only branch.
if (process.env.TEMPORAL_CREATE_TEST_TTY === '1') process.stdout.isTTY = true;

// The CLI checks connectivity before downloading a sample. Keep that check local.
const lookup = dns.lookup;
dns.lookup = function (hostname, ...args) {
  if (hostname === 'github.com') {
    const callback = args.at(-1);
    queueMicrotask(() => callback(null, '127.0.0.1', 4));
    return;
  }
  return lookup.call(this, hostname, ...args);
};
syncBuiltinESMExports();
register('./create-project-hooks.mjs', import.meta.url);
