# Temporal NodeJS SDK

## This is a work in progress, not ready for use yet

For more information see the [proposal](https://github.com/temporalio/proposals/blob/master/node/node-sdk.md).

### Development

#### Environment set up

```
git submodule init
git submodule update
npm ci
```

#### Building

```
npm run clean
npm run build
```

#### Building with watch

```
npm run clean
npm run build  # Must be run once before build.watch
npm run build.watch
```

#### Testing

```
npm run test
```

-- OR --

```
npm run test.watch
```
