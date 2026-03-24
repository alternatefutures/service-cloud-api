import pino from 'pino'
import { requestContext } from './requestContext.js'

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  formatters: {
    level: (label) => ({ level: label }),
  },
  base: { service: 'service-cloud-api' },
  mixin() {
    const store = requestContext.getStore()
    return store?.requestId ? { requestId: store.requestId } : {}
  },
})

export default logger

export function createLogger(module: string) {
  return logger.child({ module })
}
