export declare interface HistoryEvent {
  type: string;
  // type: 'WorkflowExecutionStarted' | 'TimerStarted';
  id: number;
}

export declare interface PollResult {
  taskToken: string;
  history: HistoryEvent[];
}

export declare class Worker {
  constructor(queueName: string);
  poll(callback: (err?: Error, result?: any) => void): void;
}
