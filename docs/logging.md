### Logging

The worker comes with a default logger which defaults to log any messages with level `INFO` and higher to `STDERR` using `console.error`.

The rationale behind this is to minimize worker dependencies and allow SDK users to bring their own logger.

#### Customizing the default logger

```ts
import { Worker, DefaultLogger } from '@temporalio/worker';

// Set up the DefaultLogger to log only WARNING and ERROR messages with a custom log function
const logger = new DefaultLogger('WARNING', (severity, message, meta) => {
  /* Implement this in order to generate custom log output */
});
const worker = await Worker.create(__dirname, { logger });
```

#### BYOL - Bring your own logger

```ts
import { Worker } from '@temporalio/worker';
import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [new winston.transports.Console()],
});
const worker = await Worker.create(__dirname, { logger });
```
