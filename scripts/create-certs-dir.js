// Create /tmp/temporal-certs and populate it with certs from env vars.
// Used in CI flow to store the Cloud certs from GH secret into local files for testing the mTLS sample.
const fs = require('fs-extra');

const targetDir = process.argv[2] ?? '/tmp/temporal-certs';

fs.mkdirsSync(targetDir);
fs.writeFileSync(`${targetDir}/client.pem`, process.env.TEMPORAL_CLIENT_CERT);
fs.writeFileSync(`${targetDir}/client.key`, process.env.TEMPORAL_CLIENT_KEY);
