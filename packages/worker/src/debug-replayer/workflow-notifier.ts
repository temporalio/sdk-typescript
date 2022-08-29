import { workflowInfo } from '@temporalio/workflow';

class WorkflowNotifier {
  static _instance?: WorkflowNotifier;

  /**
   * Access the singleton instance - one per workflow context
   */
  static instance(): WorkflowNotifier {
    if (this._instance === undefined) {
      this._instance = new this();
    }
    return this._instance;
  }

  private constructor() {
    // Dear eslint,
    // I left this empty to mark the constructor private, OK?
    //
    // Best regards,
    // - An anonymous developer
  }

  lastNotifiedStartEvent = -1;

  notifyRunner(): void {
    const eventId = workflowInfo().historyLength;
    if (this.lastNotifiedStartEvent >= eventId) return;
    this.lastNotifiedStartEvent = eventId;
    try {
      // Use global `notifyRunner` function, should be injected outside of workflow context.
      // Using globalThis.constructor.constructor, we break out of the workflow context to Node.js land.
      const notifyRunner = globalThis.constructor.constructor('return notifyRunner')();
      notifyRunner(eventId);
    } catch {
      // ignore
    }
  }
}

/**
 * Notify a runner process when a workflow task is picked up
 */
export function notifyRunner(): void {
  WorkflowNotifier.instance().notifyRunner();
}
