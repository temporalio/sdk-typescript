Loren & Roey surveyed the available protobuf libraries in Dec '21 for use with our `ProtobufBinaryDataConverter` and `ProtobufJsonDataConverter`. The main criteria was:

- A. TypeScript types for messages
- B. Being able to check at runtime whether an object passed to the SDK as input or returned to the SDK from a workflow/query/activity is meant to be protobuf-serialized, without adding annotations to the functions.
- C. Spec-compliant [proto3 JSON encoding](https://developers.google.com/protocol-buffers/docs/proto3#json) so that the TS SDK is interoperable with the other SDKs

## Options

### protobufjs

A and B, but not C.

- Most popular lib (5M downloads/wk)
- Fairly inactive maintainers (infrequent updates, many open PRs & issues)
- [Non-standard](https://github.com/protobufjs/protobuf.js/issues/1304) JSON serialization
- Message classes with generated types and runtime-checkable instances

### proto3-json-serializer

C

- Adds spec-compliant JSON encoding to protobufjs
- Maintained by responsive Googlers, 900k downloads/wk
- Requires runtime-loaded messages (not compatible with generated classes)

### google-protobuf

B

- Official Google lib, 800k downloads/wk
- No types or JSON encoding
- Compiler installed separately (not on npm)

### ts-proto

A and some of C

- Generates TS interfaces and encoding functions
- Designed for POJOs (no instances of message classes), so can't do B
- JSON encoding is probably [not yet fully spec compliant](https://github.com/stephenh/ts-proto/pull/448#issuecomment-998166664)

### protoc-gen-ts

A and B

- Plugin for Google's `protoc` compiler
- Generated classes extend `google-protobuf`'s Message, but doesn't add JSON
- Maintainer [seems interested in JSON encoding](https://github.com/protocolbuffers/protobuf/issues/4540#issuecomment-915609405), but isn't there yet (only has `to/fromObject` methods—need eg a fromJSON that converts the below base64 to a bytearray, and a toJSON that converts a bytearray to base64)

## Current solution

- Use `protobufjs` with `proto3-json-serializer`
- Have users use runtime-loaded messages (not generated classes) and `Class.create` (not `new Class()`, which doesn't work with runtime-loaded messages)
- Patch `json-module` output (which adds `nested` attributes to lowercase namespaces [which causes a TS error](https://github.com/protobufjs/protobuf.js/issues/1014))

```ts
// json-module.js generated with:
// pbjs -t json-module -w commonjs -o json-module.js *.proto

// protos/root.js
const { patchProtobufRoot } = require('@temporalio/common');
const unpatchedRoot = require('./json-module');
module.exports = patchProtobufRoot(unpatchedRoot);

// root.d.ts generated with:
// pbjs -t static-module *.proto | pbts -o root.d.ts -

// src/data-converter.ts
import { DefaultDataConverter } from '@temporalio/common';
import root from '../protos/root';

export const dataConverter = new DefaultDataConverter({ root });

// src/worker.ts
import { dataConverter } from './data-converter';

const worker = Worker.create({ dataConverter, ... });

// src/client.ts
import { foo } from '../protos/root';
import { dataConverter } from './data-converter';

const client = new WorkflowClient(connection.service, { dataConverter });
await client.start(protoWorkflow, {
  args: [foo.bar.ProtoInput.create({ name: 'Proto', age: 1 })], // can't use `new foo.bar.ProtoInput()`
  taskQueue: 'tutorial',
  workflowId: 'my-business-id',
});

// src/workflows.ts
import { foo } from '../protos/root';

export async function protoWorkflow(input: foo.bar.ProtoInput): Promise<foo.bar.ProtoResult> {
  return foo.bar.ProtoResult.create({ sentence: `Name is ${input.name}` });
}
```

We originally were thinking of this, but the namespaces in `json-module.js` get lost through `patchProtobufRoot()`:

```ts
import * as generatedRoot from '../protos/json-module';

const patchProtobufRoot = <T>(x: T): T => x;
const root = patchProtobufRoot(generatedRoot);

function myWorkflowError(input: root.foo.bar.ProtoActivityInput) {
  return input.name;
}
```

On root in `root.foo.bar.ProtoActivityInput`, TS errors: `Cannot find namespace 'root'.`

## Future work

If we can get changes merged into `protobufjs` (or want to fork), we can do one or both of the below:

1. Change the `json-module` output to not have `nested` attributes so we don't have to patch
2. Add to the generated classes:

- spec-compliant `to/fromJSON` methods
- `typename` field that includes the namespace (eg `"foo.bar.MyMessage"`)
- "this is a generated file" comment @ top
