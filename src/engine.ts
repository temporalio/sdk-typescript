import fs from 'fs/promises';
import ivm from 'isolated-vm';

export enum ApplyMode {
  ASYNC = 'apply',
  SYNC = 'applySync',
  IGNORED = 'applyIgnored',
  SYNC_PROMISE = 'applySyncPromise',
}

const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;

export class Workflow {
  public readonly id: string;

  private constructor(
    readonly isolate: ivm.Isolate,
    readonly context: ivm.Context
  ) {
    const jail = context.global;
    jail.setSync('global', jail.derefInto());
    this.id = 'TODO';
  }

  public static async create() {
    const isolate = new ivm.Isolate();
    const context = await isolate.createContext();
    return new Workflow(isolate, context);
  }

  public async inject(
    path: string,
    handler: Function,
    applyMode?: ApplyMode,
    transferOptions?: ivm.TransferOptionsBidirectional
  ) {
    transferOptions = { arguments: { copy: true }, result: { copy: true }, ...transferOptions };

    if (applyMode === undefined) {
      if (handler instanceof AsyncFunction) {
        applyMode = ApplyMode.SYNC_PROMISE;
      } else {
        applyMode = ApplyMode.SYNC;
      }
    }

    await this.context.evalClosure(`global.${path} = function(...args) {
      return $0.${applyMode}(
        undefined,
        args,
        ${JSON.stringify(transferOptions)},
      );
    }`, [handler], { arguments: { reference: true } });
  }

  public async run(path: string) {
    const code = await fs.readFile(path, 'utf8');
    const script = await this.isolate.compileScript(code);
    await script.run(this.context);
  }
}
