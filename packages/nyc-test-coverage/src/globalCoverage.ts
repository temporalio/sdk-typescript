import { CoverageMapData } from 'istanbul-lib-coverage';

declare global {
  var __coverage__: CoverageMapData;
}

export {};
