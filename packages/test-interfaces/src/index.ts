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

// @@@SNIPSTART nodejs-workflow-signal-interface
export interface Interruptable extends Workflow {
  main(): void;
  signals: {
    interrupt(reason: string): void;
  };
}
// @@@SNIPEND

export interface Failable extends Workflow {
  main(): void;
  signals: {
    fail(): void;
  };
}

export interface AsyncFailable extends Workflow {
  main(): void;
  signals: {
    fail(): Promise<void>;
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

export interface Sleeper extends Workflow {
  main(ms?: number): Promise<void>;
}

export interface ActivitySignalHandler extends Workflow {
  main(): Promise<void>;
  signals: {
    activityStarted(): void;
    activityCancelled(): void;
  };
}

export interface CancellableHTTPRequest extends Workflow {
  main(url: string, completeOnActivityCancellation: boolean): Promise<void>;
  signals: {
    activityStarted(): void;
    activityCancelled(): void;
  };
}
