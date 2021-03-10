import { dirname, resolve as pathResolve, join as pathJoin, extname, sep } from 'path';
import { Stats } from 'fs';
import * as babel from '@babel/core';
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
  } else if (stats.isDirectory()) {
    // Even if this is a directory we still want to give precedence to loading a js file if it exists
    if (ext === '') {
      try {
        return await resolveFilename(`${path}.js`, false);
      } catch (err) {
        if (!(err instanceof LoaderError)) {
          throw err;
        }
      }
    }
    if (allowDir) {
      return await resolveFilename(pathResolve(path, 'index.js'), false);
    } else {
      throw new LoaderError(`Could not find file: ${path}`);
    }
  } else {
    throw new LoaderError(`Invalid path, expected file or directory: ${path}`);
  }
}

const isAbsPath = (specifier: string) => /^(\/|\\|[a-zA-Z]:\\)/.test(specifier);

export type ModuleType = 'commonjs' | 'esmodule';
export interface ResolvedModule {
  path: string;
  type: ModuleType;
}

export async function resolveModuleFromNodeModules(
  specifier: string,
  nodeModulesPath: string
): Promise<ResolvedModule> {
  const packagePath = pathResolve(nodeModulesPath, specifier);
  const packageJsonPath = pathResolve(packagePath, 'package.json');
  // TODO: support package.json exports
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  if (typeof packageJson.module === 'string') {
    return { path: pathResolve(packagePath, packageJson.module), type: 'esmodule' };
  }
  if (typeof packageJson.main === 'string') {
    let index = packageJson.main;
    if (extname(index) === '') {
      index = `${index}.js`;
    }
    return { path: pathResolve(packagePath, index), type: 'commonjs' };
  }
  throw new LoaderError(`Package entrypoint not found: ${specifier}`);
}

export async function resolveModule(
  specifier: string,
  referrer: string,
  moduleType: ModuleType
): Promise<ResolvedModule> {
  if (specifier.startsWith('.')) {
    // relative path
    try {
      return { path: await resolveFilename(pathResolve(dirname(referrer), specifier)), type: moduleType };
    } catch (err) {
      // referrer: a.js, specifier b -> a/b
      if (err instanceof LoaderError && referrer.endsWith('.js')) {
        return { path: await resolveFilename(pathResolve(referrer.replace(/\.js$/, ''), specifier)), type: moduleType };
      }
      throw err;
    }
  } else if (isAbsPath(specifier)) {
    return { path: await resolveFilename(specifier), type: moduleType };
  }

  const nodeModulesPath = await findNodeModules(referrer, '/');
  // nodeModulesPath should end with `node_modules`.
  // Slice to get rid of the last empty part returned from split() because we'll append node_modules below
  let parts = nodeModulesPath.split('node_modules').slice(0, -1);

  while (parts.length > 0) {
    // TODO: root on windows FS
    try {
      return await resolveModuleFromNodeModules(specifier, pathResolve(parts.join('node_modules'), 'node_modules'));
    } catch (err) {
      if (err instanceof LoaderError || err.code === 'ENOENT') {
        parts = parts.slice(0, -1);
        continue;
      }
      throw err;
    }
  }
  throw new LoaderError(`Recursive lookup of ${specifier} failed for referrer ${referrer}`);
}

export async function commonjsToEsModule(code: string): Promise<string> {
  const transformed = await new Promise<babel.BabelFileResult>((resolve, reject) =>
    babel.transform(
      code,
      {
        plugins: ['transform-commonjs'],
      },
      (err, result) => {
        if (result === null) reject(err);
        else resolve(result);
      }
    )
  );
  if (!transformed?.code) {
    throw new LoaderError('Failed to transform source from commonjs to ES module');
  }

  return transformed.code;
}

export class Loader {
  private readonly moduleCache: Map<string, Promise<ivm.Module>> = new Map();
  private readonly moduleOverrides: Map<string, ivm.Module> = new Map();

  constructor(private readonly isolate: ivm.Isolate, private readonly context: ivm.Context) {}

  public overrideModule(specifier: string, module: ivm.Module): void {
    this.moduleOverrides.set(specifier, module);
  }

  public async loadModuleFromSource(code: string, resolved: ResolvedModule): Promise<ivm.Module> {
    if (resolved.type === 'commonjs') {
      code = await commonjsToEsModule(code);
    }
    const compiled = await this.isolate.compileModule(code, { filename: resolved.path });
    (compiled as any).filename = resolved.path; // Hacky way of resolving relative imports
    (compiled as any).moduleType = resolved.type; // Hacky way of preserving the module type
    await compiled.instantiate(this.context, this.moduleResolveCallback.bind(this));
    await compiled.evaluate();
    return compiled;
  }

  public async loadModule(filename: string, moduleType: ModuleType = 'esmodule'): Promise<ivm.Module> {
    const cached = this.moduleCache.get(filename);
    if (cached !== undefined) {
      return cached;
    }
    const promise = (async () => {
      const code = await fs.readFile(filename, 'utf8');
      return this.loadModuleFromSource(code, { path: filename, type: moduleType });
    })();
    this.moduleCache.set(filename, promise);
    return promise;
  }

  protected async moduleResolveCallback(specifier: string, referrer: ivm.Module): Promise<ivm.Module> {
    const override = this.moduleOverrides.get(specifier);
    if (override !== undefined) {
      return override;
    }
    const { filename: referrerFilename, moduleType } = referrer as any;
    const specifierParts = specifier.split(sep);
    const basePartLength = specifier.startsWith('@') ? 2 : 1;
    if (specifierParts.length > basePartLength) {
      const base = pathJoin(...specifierParts.slice(0, basePartLength));
      const { path: basePath, type: baseType } = await resolveModule(base, referrerFilename, moduleType);
      const rest = ['.', ...specifierParts.slice(basePartLength)].join(sep);
      const { path, type } = await resolveModule(rest, basePath, baseType);
      return this.loadModule(path, type);
    } else {
      const { path, type } = await resolveModule(specifier, referrerFilename, moduleType);
      return this.loadModule(path, type);
    }
  }
}
