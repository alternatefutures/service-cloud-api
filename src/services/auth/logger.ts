/**
 * Structured Logger for Auth Services
 *
 * Provides consistent, structured logging with context and metadata support.
 * Outputs JSON-formatted logs suitable for log aggregation and analysis.
 */

export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
}

export interface LogContext {
  service?: string;
  userId?: string;
  tokenId?: string;
  operation?: string;
  [key: string]: any;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: LogContext;
  error?: {
    name: string;
    message: string;
    stack?: string;
    code?: string;
  };
}

// Extended Error interface with optional code property
interface ErrorWithCode extends Error {
  code?: string;
}

class Logger {
  private service: string;
  private minLevel: LogLevel;

  constructor(service: string = 'auth', minLevel: LogLevel = LogLevel.INFO) {
    this.service = service;
    this.minLevel = minLevel;
  }

  private shouldLog(level: LogLevel): boolean {
    const levels = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR];
    return levels.indexOf(level) >= levels.indexOf(this.minLevel);
  }

  private formatLog(level: LogLevel, message: string, context?: LogContext, error?: Error): LogEntry {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context: {
        service: this.service,
        ...context,
      },
    };

    if (error) {
      const errorWithCode = error as ErrorWithCode;
      entry.error = {
        name: error.name,
        message: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
        code: errorWithCode.code,
      };
    }

    return entry;
  }

  private log(level: LogLevel, message: string, context?: LogContext, error?: Error): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const entry = this.formatLog(level, message, context, error);

    // In production, use JSON format for log aggregation
    // In development, use pretty format for readability
    if (process.env.NODE_ENV === 'production') {
      console.log(JSON.stringify(entry));
    } else {
      const prefix = `[${entry.level.toUpperCase()}] [${entry.context?.service}]`;
      const ctx = entry.context ? ` ${JSON.stringify(entry.context)}` : '';
      const err = entry.error ? `\n${entry.error.stack || entry.error.message}` : '';
      console.log(`${prefix} ${entry.message}${ctx}${err}`);
    }
  }

  debug(message: string, context?: LogContext): void {
    this.log(LogLevel.DEBUG, message, context);
  }

  info(message: string, context?: LogContext): void {
    this.log(LogLevel.INFO, message, context);
  }

  warn(message: string, context?: LogContext, error?: Error): void {
    this.log(LogLevel.WARN, message, context, error);
  }

  error(message: string, context?: LogContext, error?: Error): void {
    this.log(LogLevel.ERROR, message, context, error);
  }
}

// Export singleton instances for different services
export const authLogger = new Logger('auth');
export const rateLimiterLogger = new Logger('rate-limiter');
export const tokenServiceLogger = new Logger('token-service');
