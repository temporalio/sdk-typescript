/**
 * Shared Nexus notification contracts.
 *
 * @module
 */

export type {
  OnCompleteRequest,
  OnCompleteRequestResult,
  OnCompleteResponse,
} from './nexus/notifications/generated/models';
export {
  onCompleteRequestTransferTypeConverter,
  onCompleteResponseTransferTypeConverter,
} from './nexus/notifications/generated/models';
