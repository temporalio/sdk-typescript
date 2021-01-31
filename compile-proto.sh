rm -rf proto
mkdir proto
npx pbjs --path ../sdk-core/protos/api_upstream ../sdk-core/protos/local/core_interface.proto --wrap commonjs --target static-module --out proto/core-interface.js
npx pbts --out proto/core-interface.d.ts proto/core-interface.js
mkdir proto/isolate
cp node_modules/protobufjs/dist/minimal/protobuf.js proto/isolate/core-interface.js
npx pbjs --path ../sdk-core/protos/api_upstream ../sdk-core/protos/local/core_interface.proto --wrap es6 --target static-module >> proto/isolate/core-interface.js
