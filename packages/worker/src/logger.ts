/**
 * Implement this interface in order to customize worker logging
 */
export interface Logger {
  trace(message: string, meta?: Record<string, any>): any;
  debug(message: string, meta?: Record<string, any>): any;
  info(message: string, meta?: Record<string, any>): any;
  warn(message: string, meta?: Record<string, any>): any;
  error(message: string, meta?: Record<string, any>): any;
}

export type LogLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';

const severities: LogLevel[] = ['TRACE', 'DEBUG', 'INFO', 'WARNING', 'ERROR'];

/**
 * Log messages using `console.error` and basic formatting
 */
function defaultLogFunction(level: LogLevel, message: string, meta?: Record<string, any>): void {
  if (meta === undefined) {
    console.error(new Date(), `[${level}]`, message);
  } else {
    console.error(new Date(), `[${level}]`, message, meta);
  }
}

/**
 * Default worker logger - uses a default log function to log messages to `console.error`.
 * See constructor arguments for customization.
 */
export class DefaultLogger implements Logger {
  protected readonly severity: number;

  constructor(public readonly level: LogLevel = 'INFO', protected readonly logFunction = defaultLogFunction) {
    this.severity = severities.indexOf(this.level);
  }

  log(level: LogLevel, message: string, meta?: Record<string, any>): void {
    if (severities.indexOf(level) >= this.severity) {
      this.logFunction(level, message, meta);
    }
  }

  public trace(message: string, meta?: Record<string, any>): void {
    this.log('TRACE', message, meta);
  }

  public debug(message: string, meta?: Record<string, any>): void {
    this.log('DEBUG', message, meta);
  }

  public info(message: string, meta?: Record<string, any>): void {
    this.log('INFO', message, meta);
  }

  public warn(message: string, meta?: Record<string, any>): void {
    this.log('WARNING', message, meta);
  }

  public error(message: string, meta?: Record<string, any>): void {
    this.log('ERROR', message, meta);
  }
}
