/// <reference path="../../src/workflow-global.d.ts" />

import * as declarations from '../../testActivities';

declare global {
  namespace activities {
    export var httpGet: Activity<typeof declarations.httpGet>;
  }
}
