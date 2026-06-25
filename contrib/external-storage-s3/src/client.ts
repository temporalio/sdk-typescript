/**
 * S3 object operations used by {@link S3StorageDriver}.
 *
 * @experimental
 */

/** Per-request options. */
export interface S3RequestOptions {
  /**
   * Aborts the in-flight request.
   */
  abortSignal?: AbortSignal;
}

/**
 * S3 driver client operations
 *
 * @experimental
 */
export interface S3StorageDriverClient {
  /** Upload `data` to the given bucket and key. */
  putObject(bucket: string, key: string, data: Uint8Array, options?: S3RequestOptions): Promise<void>;
  /** Resolve `true` if an object exists at the given bucket and key. */
  objectExists(bucket: string, key: string, options?: S3RequestOptions): Promise<boolean>;
  /** Download and resolve the bytes stored at the given bucket and key. */
  getObject(bucket: string, key: string, options?: S3RequestOptions): Promise<Uint8Array>;
  /**
   * Optional client-specific diagnostic metadata (e.g. region) that the driver
   * appends to error messages to help diagnose common misconfigurations.
   */
  describe?(): Record<string, string>;
}
