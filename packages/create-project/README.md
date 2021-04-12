# `@temporalio/create`

[![NPM](https://img.shields.io/npm/v/@temporalio/create)](https://www.npmjs.com/package/@temporalio/create)

Part of the [Temporal](https://temporal.io) [NodeJS SDK](https://www.npmjs.com/package/temporalio).

[NPM package initializer][npm-init] - sets up a new Temporal project with a preset skeleton.

### Usage

```
npm init @temporalio /path/to/project [--use-yarn] [--temporal-version TEMPORAL_VERSION]
```

#### Flags

- `--use-yarn` - configure the project with `yarn` (defaults to `npm`).
- `--temporal-version` - use specified version or `@latest` if not provided.

### Project Structure

The generated project consists of 4 sub-projects with typescript [project references][ts-project-references].

```
src/worker/ -> worker code
src/interfaces/ -> workflow interfaces
src/workflows/ -> workflows implementations
src/activities/ -> activities implementations
```

This code structure is required for enabling workflows - which run in an [isolated environment](#workflows) - to specify a custom `tsconfig.json` than the rest of the project.

#### References

[![](https://mermaid.ink/svg/eyJjb2RlIjoiZ3JhcGggVERcbiAgICBXUksod29ya2VyKSAtLT4gV0ZcbiAgICBXRih3b3JrZmxvd3MpIC0tPiBJXG4gICAgV0YgLS0-IEFcbiAgICBBKGFjdGl2aXRpZXMpIC0tPiBJXG4gICAgV1JLIC0tPiBJXG4gICAgSShpbnRlcmZhY2VzKSIsIm1lcm1haWQiOnsidGhlbWUiOiJkZWZhdWx0IiwiZmxvd2NoYXJ0Ijp7ImN1cnZlIjoiYmFzaXMifSwidGhlbWVDU1MiOiIubGFiZWwgZm9yZWlnbk9iamVjdCB7IG92ZXJmbG93OiB2aXNpYmxlOyB9In0sInVwZGF0ZUVkaXRvciI6ZmFsc2V9)](https://mermaid-js.github.io/mermaid-live-editor/#/edit/eyJjb2RlIjoiZ3JhcGggVERcbiAgICBXUksod29ya2VyKSAtLT4gV0ZcbiAgICBXRih3b3JrZmxvd3MpIC0tPiBJXG4gICAgV0YgLS0-IEFcbiAgICBBKGFjdGl2aXRpZXMpIC0tPiBJXG4gICAgV1JLIC0tPiBJXG4gICAgSShpbnRlcmZhY2VzKSIsIm1lcm1haWQiOnsidGhlbWUiOiJkZWZhdWx0IiwiZmxvd2NoYXJ0Ijp7ImN1cnZlIjoiYmFzaXMifSwidGhlbWVDU1MiOiIubGFiZWwgZm9yZWlnbk9iamVjdCB7IG92ZXJmbG93OiB2aXNpYmxlOyB9In0sInVwZGF0ZUVkaXRvciI6ZmFsc2V9)

Each of the referenced projects can be imported using [typescript path aliases][tsconfig-paths].  
The following aliases are included in the initializer package:

- `@interfaces`
- `@workflows`
- `@activities`

### Working with the created project

The created project comes with some helper package scripts.

- `npm run build` - Compile Typescript
- `npm run build.watch` - Watch files and compile on change

#### Running the example

- Compile the project with one of the commands above
- Download, install, and run the [Temporal server][local-server] via docker-compose
- Start the worker `node lib/worker/index.js`
- In a new terminal, use the provided client to start a workflow `node lib/worker/test.js`

[ts-project-references]: https://www.typescriptlang.org/tsconfig#references
[npm-init]: https://docs.npmjs.com/cli/v6/commands/npm-init
[tsconfig-paths]: https://www.typescriptlang.org/tsconfig#paths
[local-server]: https://docs.temporal.io/docs/server-quick-install
