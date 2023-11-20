import { RUN_INTEGRATION_TESTS, ByteSkewerPayloadCodec } from './helpers';
import { runIntegrationTests } from './integration-tests-old';

if (RUN_INTEGRATION_TESTS) {
  runIntegrationTests(new ByteSkewerPayloadCodec());
}
