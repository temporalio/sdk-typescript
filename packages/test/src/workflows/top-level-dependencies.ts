import { Context } from '@temporalio/workflow';
import { TestDependencies } from '../interfaces/dependencies';

const { syncVoid } = Context.dependencies<TestDependencies>();
const errors: string[] = [];

try {
  syncVoid.sync(0);
} catch (err) {
  errors.push(err.toString());
}

export async function main(): Promise<void> {
  console.log(errors);
}
