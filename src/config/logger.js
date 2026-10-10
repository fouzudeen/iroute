import pino from 'pino';

function createLogger() {
  const options = {
    level: process.env.LOG_LEVEL || 'info'
  };

  if (process.env.NODE_ENV === 'development') {
    try {
      options.transport = { target: 'pino-pretty' };
    } catch {
      // pino-pretty not installed; fall back to default JSON logs
    }
  }

  return pino(options);
}

export const logger = createLogger();
