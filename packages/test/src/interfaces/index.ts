import { Workflow } from '@temporalio/workflow';

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
  main(): Promise<string>;
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
  };
}

export interface CancellableHTTPRequest extends Workflow {
  main(url: string): Promise<void>;
  signals: {
    activityStarted(): void;
  };
}

export interface ContinueAsNewFromMainAndSignal extends Workflow {
  main(continueFrom?: 'main' | 'signal' | 'none'): Promise<void>;
  signals: {
    continueAsNew(): void;
  };
}

export type WorkflowCancellationScenarioOutcome = 'complete' | 'cancel' | 'fail';
export type WorkflowCancellationScenarioTiming = 'immediately' | 'after-cleanup';

export interface WorkflowCancellationScenarios extends Workflow {
  main(outcome: WorkflowCancellationScenarioOutcome, when: WorkflowCancellationScenarioTiming): Promise<void>;
}

// @@@SNIPSTART nodejs-blocked-interface
export interface Blocked extends Workflow {
  main(): Promise<void>;
  queries: {
    isBlocked(): boolean;
  };
  signals: {
    unblock(): void;
  };
}
// @@@SNIPEND
