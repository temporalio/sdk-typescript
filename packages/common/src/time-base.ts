import { StringValue } from 'ms';

/**
 * A duration, expressed either as a number of milliseconds, or as a {@link https://www.npmjs.com/package/ms | ms-formatted string}.
 */
export type Duration = StringValue | number;
