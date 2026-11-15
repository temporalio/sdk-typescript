/**
 * Client config extension that loads Temporal client credentials from AWS Secrets Manager.
 *
 * @experimental The AWS Secrets Manager extension is an experimental feature; APIs may change without notice.
 * @module
 */

export { EXTENSION_NAME, SecretsManagerExtension, type SecretsManagerExtensionOptions } from './extension';
