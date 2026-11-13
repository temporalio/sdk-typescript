Fix a regression introduced in 1.24.0 where Workflow payload codecs received empty protobuf defaults instead of `undefined` for absent payload data, while preserving explicitly empty byte arrays.
