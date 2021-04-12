import { Example } from '@interfaces/workflows';
import { greet } from '@activities/greeter';

async function main(name: string): Promise<string> {
  return greet(name);
}

export const workflow: Example = { main };
