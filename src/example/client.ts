import { Connection } from '../workflow-client';
import { ArgsAndReturn } from '../../workflow-interfaces/lib';

function u8(s: string): Uint8Array {
  // TextEncoder requires lib "dom"
  // @ts-ignore
  return new TextEncoder().encode(s);
}

async function main() {
  const client = new Connection();
  const workflow = client.workflow<ArgsAndReturn>('args-and-return', { taskQueue: 'test' });
  console.log(await workflow('Hello', undefined, u8('world!')));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1)
  });
