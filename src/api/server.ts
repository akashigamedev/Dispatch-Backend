import express, { type Request, type Response, type NextFunction } from 'express'
import { notFound, errorHandler } from '../util/errors.js'
import { log } from '../log.js'
import healthRouter from './routes/health.js'
import statusRouter from './routes/status.js'
import tasksRouter from './routes/tasks.js'
import checkinRouter from './routes/checkin.js'

function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now()
  res.on('finish', () => {
    log.info(
      { method: req.method, url: req.url, status: res.statusCode, ms: Date.now() - start },
      'request',
    )
  })
  next()
}

export function createServer() {
  const app = express()

  app.use(express.json())
  app.use(requestLogger)

  app.use(healthRouter)
  app.use(statusRouter)
  app.use(tasksRouter)
  app.use(checkinRouter)

  app.use(notFound)
  app.use(errorHandler)

  return app
}
