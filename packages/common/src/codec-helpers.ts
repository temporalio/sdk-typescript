import { PayloadCodec, ProtoFailure } from '@temporalio/workflow-common';

/**
 * Run `codec.encode()` on the {@link Payload}s in a {@link ProtoFailure}.
 */
export async function encodeFailure(failure: ProtoFailure, codec: PayloadCodec): Promise<ProtoFailure> {
  if (failure.cause) {
    await encodeFailure(failure.cause, codec);
  }

  if (failure.applicationFailureInfo?.details?.payloads?.length) {
    failure.applicationFailureInfo.details.payloads = await codec.encode(
      failure.applicationFailureInfo.details.payloads
    );
  }
  if (failure.timeoutFailureInfo?.lastHeartbeatDetails?.payloads?.length) {
    failure.timeoutFailureInfo.lastHeartbeatDetails.payloads = await codec.encode(
      failure.timeoutFailureInfo.lastHeartbeatDetails.payloads
    );
  }
  if (failure.canceledFailureInfo?.details?.payloads?.length) {
    failure.canceledFailureInfo.details.payloads = await codec.encode(failure.canceledFailureInfo.details.payloads);
  }
  if (failure.resetWorkflowFailureInfo?.lastHeartbeatDetails?.payloads?.length) {
    failure.resetWorkflowFailureInfo.lastHeartbeatDetails.payloads = await codec.encode(
      failure.resetWorkflowFailureInfo.lastHeartbeatDetails.payloads
    );
  }
  return failure;
}

// export async function deserializeFailure(
//   failure: ProtoFailure,
//   dataConverter: DataConverter
// ): Promise<DeserializedFailure> {
//   const deserializedFailure = failure as DeserializedFailure;
//   if (failure.cause) {
//     await deserializeFailure(failure.cause, dataConverter);
//   }

//   if (failure.applicationFailureInfo?.details) {
//     deserializedFailure.applicationFailureInfo.details.payloads = await arrayFromPayloads(
//       dataConverter,
//       failure.applicationFailureInfo.details.payloads
//     );
//   }
//   if (failure.timeoutFailureInfo?.lastHeartbeatDetails?.payloads) {
//     deserializedFailure.timeoutFailureInfo.lastHeartbeatDetails.payloads = await dataConverter.fromPayloads(
//       0,
//       failure.timeoutFailureInfo.lastHeartbeatDetails?.payloads
//     );
//   }
//   if (failure.canceledFailureInfo?.details?.payloads) {
//     deserializedFailure.canceledFailureInfo.details.payloads = await arrayFromPayloads(
//       dataConverter,
//       failure.canceledFailureInfo.details.payloads
//     );
//   }
//   if (failure.resetWorkflowFailureInfo?.lastHeartbeatDetails?.payloads) {
//     deserializedFailure.resetWorkflowFailureInfo.lastHeartbeatDetails.payloads = await arrayFromPayloads(
//       dataConverter,
//       failure.resetWorkflowFailureInfo.lastHeartbeatDetails.payloads
//     );
//   }
//   return deserializedFailure;
// }
