export declare interface PollResult {
  // type: 'WorkflowExecutionStarted' | 'TimerStarted';
  taskToken: string;
  type: string;
}

export declare class Worker {
  constructor(queueName: string);
  poll(callback: (err?: Error, result?: any) => void): void;
}
