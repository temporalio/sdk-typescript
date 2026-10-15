import { readFileSync } from 'fs';
import arg from 'arg';
import { status } from '@grpc/grpc-js';
import { Connection, isGrpcServiceError } from '@temporalio/client';
import type { SetupArgSpec } from './args';
import { setupArgSpec, getRequired } from './args';
import { createNamespace } from './namespace';

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
    await connection.workflowService.describeNamespace({ namespace });
    // Namespace already exists. Nothing to do
    return;
  } catch (err) {
    if (!isGrpcServiceError(err) || err.code !== status.NOT_FOUND) {
      throw err;
    }
  }

  await createNamespace(connection, namespace);
  console.log('Registered namespace', { namespace });
}

main()
  .then(() => {
    process.exit();
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
