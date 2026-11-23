import { transform, type Options } from '@swc/core';
import type { LoaderDefinitionFunction } from 'webpack';
import { withActivityReferences } from './activity-reference-plugin';

/** Compile workflow TypeScript and substitute Activity imports before dependency discovery. */
const activityReferenceLoader: LoaderDefinitionFunction<Options> = function (source, inputSourceMap) {
  const callback = this.async();
  const filename = this.resourcePath;
  this.cacheable();
  void transform(
    source,
    withActivityReferences({
      ...this.getOptions(),
      filename,
      sourceFileName: filename,
      inputSourceMap:
        typeof inputSourceMap === 'string'
          ? inputSourceMap
          : inputSourceMap
            ? JSON.stringify(inputSourceMap)
            : undefined,
    })
  ).then(
    (output) => callback(null, output.code, output.map ? JSON.parse(output.map) : undefined),
    (error: Error) => callback(error)
  );
};

export = activityReferenceLoader;
