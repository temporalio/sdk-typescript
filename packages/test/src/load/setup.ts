import { readFileSync } from 'fs';
import arg from 'arg';
import { Connection } from '@temporalio/client';
import { createNamespace, waitOnNamespace } from '@temporalio/testing/lib/utils';
import type { SetupArgSpec } from './args';
import { setupArgSpec, getRequired } from './args';

async function main() {
  const args = arg<SetupArgSpec>(setupArgSpec);

  const serverAddress = getRequired(args, '--server-address');
  const namespace = getRequired(args, '--ns');
  const clientCertPath = args['--client-cert-path'];
  const clientKeyPath = args['--client-key-path'];

  const tlsConfig =
    clientCertPath && clientKeyPath
      ? {
          tls: {
            clientCertPair: {
              crt: readFileSync(clientCertPath),
              key: readFileSync(clientKeyPath),
            },
          },
        }
      : {};

  const connection = await Connection.connect({ address: serverAddress, ...tlsConfig });

  console.log('Checking if namespace already exists', { namespace });
  try {
    await waitOnNamespace(connection, namespace, 1, 0);
    // Namespace already exists. Nothing to do
    return;
  } catch (_e) {
    // Ignore error. Will create namespace if it does not exist
  }

  await createNamespace(connection, namespace);
  console.log('Registered namespace', { namespace });
  await waitOnNamespace(connection, namespace);
  console.log('Wait complete on namespace', { namespace });
}

main()
  .then(() => {
    process.exit();
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
