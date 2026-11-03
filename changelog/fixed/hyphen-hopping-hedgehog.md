`@temporalio/envconfig` now converts every underscore in gRPC metadata keys to a hyphen, so keys such as `TEMPORAL_GRPC_META_X_MY_HEADER` map to `x-my-header` instead of `x-my_header`.
