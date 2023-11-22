/**
 * Our most recent style of integration tests are those in the
 * integration-tests/ directory. This file has been given the suffix -old to
 * distinguish the different variants.
 */

import { RUN_INTEGRATION_TESTS } from './helpers';
import { runIntegrationTests } from './integration-tests-old';

if (RUN_INTEGRATION_TESTS) {
  runIntegrationTests();
}
