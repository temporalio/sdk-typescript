import ivm from 'isolated-vm';
import { WorkflowIsolateBuilder } from './isolate-builder';

/**
 * Implement this interface in order to customize Workflow isolate context creation
 */
export interface IsolateContextProvider {
  /**
   * Get an isolate context for running a Workflow
   */
  getContext(): Promise<ivm.Context>;

  /**
   * Destroy and cleanup any resources
   */
  destroy(): void;
}

/**
 * Maintains a pool of v8 isolates, returns Context in a round-robin manner.
 * Pre-compiles the bundled Workflow code from provided {@link WorkflowIsolateBuilder}.
 */
export class RoundRobinIsolateContextProvider implements IsolateContextProvider {
  nextIsolateIdx = 0;

  protected constructor(
    public readonly poolSize: number,
    public readonly isolates: ivm.Isolate[],
    public readonly scripts: ivm.Script[]
  ) {}

  public async getContext(): Promise<ivm.Context> {
    const isolateIdx = this.nextIsolateIdx;
    this.nextIsolateIdx = (this.nextIsolateIdx + 1) % this.poolSize;
    const isolate = this.isolates[isolateIdx];
    const script = this.scripts[isolateIdx];
    const context = await isolate.createContext();
    await script.run(context);
    return context;
  }

  /**
   * Create a new instance, isolates and pre-compiled scripts are generated here
   */
  public static async create(
    builder: WorkflowIsolateBuilder,
    poolSize: number,
    maxIsolateMemoryMB: number
  ): Promise<RoundRobinIsolateContextProvider> {
    const code = await builder.createBundle();
    const isolates: ivm.Isolate[] = Array(poolSize);
    const scripts: ivm.Script[] = Array(poolSize);

    for (let i = 0; i < poolSize; ++i) {
      const isolate = (isolates[i] = new ivm.Isolate({ memoryLimit: maxIsolateMemoryMB }));
      scripts[i] = await isolate.compileScript(code, { filename: 'workflow-isolate' });
    }
    return new this(poolSize, isolates, scripts);
  }

  public destroy(): void {
    for (const script of this.scripts) {
      script.release();
    }
    for (const isolate of this.isolates) {
      isolate.dispose();
    }
  }
}
