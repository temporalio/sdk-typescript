import { dirname, resolve as pathResolve, extname } from 'path';
import { Stats } from 'fs';
import fs from 'fs-extra';
import ivm from 'isolated-vm';

export class LoaderError extends Error {
  public readonly name = 'LoaderError';
}

export async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await fs.stat(path);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function findNodeModules(referrer: string, fsRoot = '/'): Promise<string> {
  let root = dirname(referrer);
  for (;;) {
    const nodeModulesPath = pathResolve(root, 'node_modules');
    const stats = await statOrNull(nodeModulesPath);
    if (stats?.isDirectory()) return nodeModulesPath;
    if (root === fsRoot) throw new LoaderError(`No node_modules directory found from referrer: ${referrer}`);
    root = pathResolve(root, '..');
  }
}

export async function resolveFilename(path: string, allowDir = true): Promise<string> {
  const stats = await statOrNull(path);
  const ext = extname(path);
  if (stats === null) {
    if (ext === '') return resolveFilename(`${path}.js`, false);
    else throw new LoaderError(`Could not find file: ${path}`);
  } else if (stats.isFile()) {
    // TODO: support .mjs and other extensions?
    if (ext === '.js') return path;
    else throw new LoaderError(`Only .js files can be imported, got ${path}`);
  } else if (stats?.isDirectory()) {
    if (allowDir) return resolveFilename(pathResolve(path, 'index.js'), false);
    else throw new LoaderError(`Could not find file: ${path}`);
  } else {
    throw new LoaderError(`Invalid path, expected file or directory: ${path}`);
  }
}

const isAbsPath = (specifier: string) => /^(\/|\\|[a-zA-Z]:\\)/.test(specifier);

export async function resolveModulePath(specifier: string, referrer: string): Promise<string> {
  if (specifier.startsWith('.')) {
    // relative path
    return resolveFilename(pathResolve(dirname(referrer), specifier));
  } else if (isAbsPath(specifier)) {
    return resolveFilename(specifier);
  }
  // TODO: root on windows FS
  const nodeModulesPath = await findNodeModules(referrer, '/');
  const packagePath = pathResolve(nodeModulesPath, specifier);
  const packageJsonPath = pathResolve(packagePath, 'package.json');
  // TODO: support package.json exports
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  if (typeof packageJson.module !== 'string') {
    throw new LoaderError(`Package is not an ES module: ${specifier}`);
  }
  return pathResolve(packagePath, packageJson.module);
}

export class Loader {
  private readonly moduleCache: Map<string, ivm.Module> = new Map();
  private readonly moduleOverrides: Map<string, ivm.Module> = new Map();

  constructor(private readonly isolate: ivm.Isolate, private readonly context: ivm.Context) {}

  public overrideModule(specifier: string, module: ivm.Module): void {
    if (isAbsPath(specifier)) {
      this.moduleCache.set(specifier, module);
    } else {
      this.moduleOverrides.set(specifier, module);
    }
  }

  public async loadModule(filename: string): Promise<ivm.Module> {
    const cached = this.moduleCache.get(filename);
    if (cached) return cached;
    const code = await fs.readFile(filename, 'utf8');
    const compiled = await this.isolate.compileModule(code, { filename });
    (compiled as any).filename = filename; // Hacky way of resolving relative imports
    await compiled.instantiate(this.context, this.moduleResolveCallback.bind(this));
    await compiled.evaluate();
    this.moduleCache.set(filename, compiled);
    return compiled;
  }

  protected async moduleResolveCallback(specifier: string, referrer: ivm.Module): Promise<ivm.Module> {
    const override = this.moduleOverrides.get(specifier);
    if (override !== undefined) {
      return override;
    }
    const referrerFilename = (referrer as any).filename; // Hacky way of resolving relative imports
    const filename = await resolveModulePath(specifier, referrerFilename);
    return this.loadModule(filename);
  }
}
