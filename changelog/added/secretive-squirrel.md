New experimental `@temporalio/aws-secrets-manager` package: an `@temporalio/envconfig` extension that loads the client API key and mTLS material from AWS Secrets Manager secret IDs.
`@temporalio/lambda-worker` now loads Temporal client credentials from AWS Secrets Manager when secret IDs are configured with `TEMPORAL_EXT_AWS_SECRETS_MANAGER_*` env vars or in the TOML config.
