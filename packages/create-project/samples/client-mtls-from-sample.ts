// @@@SNIPSTART nodejs-mtls-client
import fs from 'fs';
import path from 'path';
import { Connection } from '@temporalio/client';

async function run() {
  // certsDir should be the directory created by the generate-certs.sh script from
  // https://github.com/temporalio/customization-samples/tree/master/tls/tls-full#steps-to-run-this-sample
  const [certsDir] = process.argv.slice(2);
  if (certsDir === undefined) {
    throw new Error('Please pass certs dir as single argument');
  }
  // Connect to localhost with TLS
  const connection = new Connection({
    tls: {
      serverNameOverride: 'development.cluster-x.contoso.com',
      serverRootCACertificate: fs.readFileSync(path.join(certsDir, 'cluster/ca/server-intermediate-ca.pem')),
      clientCertPair: {
        crt: fs.readFileSync(path.join(certsDir, 'client/development/client-development-namespace.pem')),
        key: fs.readFileSync(path.join(certsDir, 'client/development/client-development-namespace.key')),
      },
    },
  });
  await connection.untilReady();
  console.log('Client connection succesfully established');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
// @@@SNIPEND
