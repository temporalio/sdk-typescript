import { Workflow } from '@temporalio/workflow';

export interface SimpleQuery extends Workflow {
  main(): void;
  queries: {
    hasSlept(): boolean;
    hasSleptAsync(): Promise<boolean>;
    // Used to fail the query
    fail(): never;
  };
}

export interface Interruptable extends Workflow {
  main(): void;
  signals: {
    interrupt(reason: string): void;
    fail(): never;
  };
}

export interface ArgsAndReturn extends Workflow {
  main(greeting: string, _skip: undefined, arr: ArrayBuffer): Promise<string>;
}

export interface HTTP extends Workflow {
  main(): Promise<string[]>;
}

export interface Empty extends Workflow {
  main(): Promise<void>;
}
