/**
 * This file has been given the suffix -old because it uses an older style of
 * integration testing. New code should follow the style of integration tests in
 * the files without this suffix.
 */

import { RUN_INTEGRATION_TESTS, ByteSkewerPayloadCodec } from './helpers';
import { runIntegrationTests } from './integration-tests-old';

if (RUN_INTEGRATION_TESTS) {
  runIntegrationTests(new ByteSkewerPayloadCodec());
}
