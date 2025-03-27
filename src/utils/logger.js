import winston from 'winston';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Get the directory name
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logsDir = path.join(__dirname, '../../logs');

// Ensure logs directory exists
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Create formatters
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp(),
  winston.format.printf(({ level, message, timestamp }) => {
    return `${timestamp} ${level}: ${message}`;
  })
);

const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.json()
);

// Create logger
const logger = winston.createLogger({
  level: 'info',
  transports: [
    new winston.transports.Console({
      format: consoleFormat
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      format: fileFormat
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      format: fileFormat
    })
  ]
});

// Create a separate logger for price change alerts
const priceChangeLogger = winston.createLogger({
  level: 'info',
  transports: [
    new winston.transports.File({
      filename: path.join(logsDir, 'price-changes.log'),
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ message, timestamp }) => {
          return `${timestamp}: ${message}`;
        })
      )
    })
  ]
});

// Create a separate logger for outdated URLs
const outdatedUrlLogger = winston.createLogger({
  level: 'info',
  transports: [
    new winston.transports.File({
      filename: path.join(logsDir, 'outdated-urls.log'),
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ message, timestamp }) => {
          return `${timestamp}: ${message}`;
        })
      )
    })
  ]
});

export { logger, priceChangeLogger, outdatedUrlLogger };
