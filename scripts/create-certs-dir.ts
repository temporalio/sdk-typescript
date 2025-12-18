// Create /tmp/temporal-certs and populate it with certs from env vars.
// Used in CI flow to store the Cloud certs from GH secret into local files for testing the mTLS sample.
import { mkdirsSync, writeFileSync } from 'fs-extra';

if (!process.env.TEMPORAL_CLIENT_CERT || !process.env.TEMPORAL_CLIENT_KEY) {
  throw new Error('TEMPORAL_CLIENT_CERT and TEMPORAL_CLIENT_KEY must be set');
}

const targetDir = process.argv[2] ?? '/tmp/temporal-certs';

mkdirsSync(targetDir);
writeFileSync(`${targetDir}/client.pem`, process.env.TEMPORAL_CLIENT_CERT);
writeFileSync(`${targetDir}/client.key`, process.env.TEMPORAL_CLIENT_KEY);
