# Temporal NodeJS SDK

## This is a work in progress, not ready for use yet

For more information see the [proposal](https://github.com/temporalio/proposals/blob/master/node/node-sdk.md).

### Development

#### Environment set up

```sh
git submodule init
git submodule update
npm ci
```

#### Building

```sh
npm run clean
npm run build
```

#### Building with watch

```sh
npm run clean
npm run build  # Must be run once before build.watch
npm run build.watch
```

#### Testing

```sh
npm run test
```

-- OR --

```sh
npm run test.watch
```
