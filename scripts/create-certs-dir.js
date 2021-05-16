// Create /tmp/temporal-certs and populate it with certs from env vars.
// Used in CI flow to store the Cloud certs from GH secret into local files for testing the mTLS sample.
const fs = require('fs-extra');

fs.mkdirsSync('/tmp/temporal-certs');
fs.writeFileSync('/tmp/temporal-certs/client.pem', process.env.TEMPORAL_CLIENT_CERT);
fs.writeFileSync('/tmp/temporal-certs/client.key', process.env.TEMPORAL_CLIENT_KEY);
