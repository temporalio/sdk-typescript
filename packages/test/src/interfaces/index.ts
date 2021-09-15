// @@@SNIPSTART nodejs-workflow-signal-interface
export type Interruptable = () => {
  execute(): Promise<void>;
  signals: {
    interrupt(reason: string): void;
  };
};
// @@@SNIPEND

export type Failable = () => {
  execute(): Promise<void>;
  signals: {
    fail(): void;
  };
};

export type AsyncFailable = () => {
  execute(): Promise<void>;
  signals: {
    fail(): Promise<void>;
  };
};

export type SignalTarget = () => {
  execute(): Promise<void>;
  signals: {
    fail(message: string): void;
    unblock(): void;
  };
};

export type ArgsAndReturn = (
  greeting: string,
  _skip: undefined,
  arr: ArrayBuffer
) => {
  execute(): Promise<string>;
};

export type HTTP = () => {
  execute(): Promise<string>;
};

export type HTTPGetter = (url: string) => {
  execute(): Promise<any>;
};

export type HTTPPoster = (url: string) => {
  execute(): Promise<void>;
};

import { WorkflowExecution } from '@temporalio/common';

export type ChildTerminator = () => {
  execute(): Promise<void>;
  queries: {
    childExecution(): WorkflowExecution | undefined;
  };
};

export type Empty = () => {
  execute(): Promise<void>;
};

export type Returner<T> = () => {
  execute(): Promise<T>;
};

export type Sleeper = (ms?: number) => {
  execute(): Promise<void>;
};

export type ActivitySignalHandler = () => {
  execute(): Promise<void>;
  signals: {
    activityStarted(): void;
  };
};

export type CancellableHTTPRequest = (url: string) => {
  execute(): Promise<void>;
  signals: {
    activityStarted(): void;
  };
};

export type ContinueAsNewFromMainAndSignal = (continueFrom?: 'execute' | 'signal' | 'none') => {
  execute(): Promise<void>;
  signals: {
    continueAsNew(): void;
  };
};

export type WorkflowCancellationScenarioOutcome = 'complete' | 'cancel' | 'fail';
export type WorkflowCancellationScenarioTiming = 'immediately' | 'after-cleanup';
export type CancellationScenarioRunner = (
  outcome: WorkflowCancellationScenarioOutcome,
  when: WorkflowCancellationScenarioTiming
) => {
  execute(): Promise<void>;
};

// @@@SNIPSTART nodejs-blocked-interface
export type Blocked = () => {
  execute(): Promise<void>;
  queries: {
    isBlocked(): boolean;
  };
  signals: {
    unblock(): void;
  };
};
// @@@SNIPEND

export type Gated = () => {
  execute(): Promise<void>;
  signals: {
    someShallPass(): void;
  };
};
