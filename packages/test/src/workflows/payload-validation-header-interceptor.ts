import { defaultPayloadConverter } from '@temporalio/common';
import type { WorkflowInterceptorsFactory } from '@temporalio/workflow';

export const interceptors: WorkflowInterceptorsFactory = () => ({
  inbound: [
    {
      execute(input, next) {
        const header = input.headers.payloadValidation;
        if (header == null) return next(input);
        const value = defaultPayloadConverter.fromPayload<any>(header);
        if (value?.__payloadValidation !== 'header-roundtrip') return next(input);
        return next({ ...input, args: [value] });
      },
    },
  ],
  outbound: [
    {
      scheduleActivity(input, next) {
        const value = input.args[0] as
          | { __payloadValidationHeader?: boolean; id?: string; marker?: string }
          | undefined;
        if (!value?.__payloadValidationHeader) return next(input);
        return next({
          ...input,
          headers: {
            ...input.headers,
            payloadValidation: defaultPayloadConverter.toPayload({
              __payloadValidation: value.marker ?? 'codec-encode-once',
              id: `header-${value.id}`,
            }),
          },
        });
      },
    },
  ],
});
