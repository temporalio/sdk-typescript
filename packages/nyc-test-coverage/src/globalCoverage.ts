import type { CoverageMapData } from 'istanbul-lib-coverage';

declare global {
  // eslint-disable-next-line no-var
  var __coverage__: CoverageMapData;
}

export {};
