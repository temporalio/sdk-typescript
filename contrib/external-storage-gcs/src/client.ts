/**
 * Google Cloud Storage object operations used by {@link GcsStorageDriver}.
 *
 * @experimental
 */

/** Per-request options. */
export interface GcsRequestOptions {
  /**
   * Aborts the in-flight request.
   */
  abortSignal?: AbortSignal;
}

/**
 * GCS driver client operations
 *
 * @experimental
 */
export interface GcsStorageDriverClient {
  /**
   * Store `data` at the given bucket and object name. Payloads are
   * content-addressed, so an object that already exists holds identical bytes.
   */
  save(bucket: string, object: string, data: Uint8Array, options?: GcsRequestOptions): Promise<void>;
  /** Download and resolve the bytes stored at the given bucket and object name. */
  download(bucket: string, object: string, options?: GcsRequestOptions): Promise<Uint8Array>;
  /**
   * Optional client-specific diagnostic metadata (e.g. project ID) that the driver
   * appends to error messages to help diagnose common misconfigurations.
   */
  describe?(): Record<string, string>;
}
