import type { ExampleModel } from './example/index';
import { ExampleEnum, extractProperty } from './example/index';

// Demonstrate issue #516
export async function issue516(): Promise<string> {
  const successModel: ExampleModel = { someProperty: ExampleEnum.success };
  return extractProperty(successModel);
}
