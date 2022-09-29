import { RUN_INTEGRATION_TESTS, ByteSkewerPayloadCodec } from './helpers';
import { runIntegrationTests } from './integration-tests';

if (RUN_INTEGRATION_TESTS) {
  runIntegrationTests(new ByteSkewerPayloadCodec());
}
