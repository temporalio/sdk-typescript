import { Workflow } from '@temporalio/workflow';

// @@@SNIPSTART nodejs-workflow-signal-interface
export interface Interruptable extends Workflow {
  execute(): Promise<void>;
  signals: {
    interrupt(reason: string): void;
  };
}
// @@@SNIPEND

export interface Failable extends Workflow {
  execute(): Promise<void>;
  signals: {
    fail(): void;
  };
}

export interface AsyncFailable extends Workflow {
  execute(): Promise<void>;
  signals: {
    fail(): Promise<void>;
  };
}

export interface ArgsAndReturn extends Workflow {
  execute(greeting: string, _skip: undefined, arr: ArrayBuffer): Promise<string>;
}

export interface HTTP extends Workflow {
  execute(): Promise<string>;
}

export interface Empty extends Workflow {
  execute(): Promise<void>;
}

export interface Sleeper extends Workflow {
  execute(ms?: number): Promise<void>;
}

export interface ActivitySignalHandler extends Workflow {
  execute(): Promise<void>;
  signals: {
    activityStarted(): void;
  };
}

export interface CancellableHTTPRequest extends Workflow {
  execute(url: string): Promise<void>;
  signals: {
    activityStarted(): void;
  };
}

export interface ContinueAsNewFromMainAndSignal extends Workflow {
  execute(continueFrom?: 'execute' | 'signal' | 'none'): Promise<void>;
  signals: {
    continueAsNew(): void;
  };
}

export type WorkflowCancellationScenarioOutcome = 'complete' | 'cancel' | 'fail';
export type WorkflowCancellationScenarioTiming = 'immediately' | 'after-cleanup';

export interface WorkflowCancellationScenarios extends Workflow {
  execute(outcome: WorkflowCancellationScenarioOutcome, when: WorkflowCancellationScenarioTiming): Promise<void>;
}

// @@@SNIPSTART nodejs-blocked-interface
export interface Blocked extends Workflow {
  execute(): Promise<void>;
  queries: {
    isBlocked(): boolean;
  };
  signals: {
    unblock(): void;
  };
}
// @@@SNIPEND
