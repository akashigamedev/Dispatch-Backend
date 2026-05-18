import express, { type Request, type Response, type NextFunction } from 'express'
import { notFound, errorHandler } from '../util/errors.js'
import { log } from '../log.js'
import healthRouter from './routes/health.js'
import tasksRouter from './routes/tasks.js'
import issuesRouter from './routes/issues.js'
import settingsRouter from './routes/settings.js'
import projectsRouter from './routes/projects.js'

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
  app.use(tasksRouter)
  app.use(issuesRouter)
  app.use(settingsRouter)
  app.use(projectsRouter)

  app.use(notFound)
  app.use(errorHandler)

  return app
}
