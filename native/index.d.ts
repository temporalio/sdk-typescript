export declare class Worker {
  constructor(queueName: string);
  poll(callback: (err?: Error, result?: any) => void): void;
}
