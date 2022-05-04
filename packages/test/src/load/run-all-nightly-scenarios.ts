import scenarios from './nightly-scenarios';
import { spawnSync } from 'node:child_process';

for (const [name, config] of Object.entries(scenarios)) {
  console.log(`Running test scenario ${name}`, { config });
  spawnSync('node', [require.resolve('./all-in-one'), ...Object.entries(config).flatMap(([k, v]) => [k, `${v}`])], {
    stdio: 'inherit',
  });
}
