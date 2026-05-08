import express from 'express'
import { notFound, errorHandler } from '../util/errors.js'
import healthRouter from './routes/health.js'
import statusRouter from './routes/status.js'
import tasksRouter from './routes/tasks.js'

export function createServer() {
  const app = express()

  app.use(express.json())

  app.use(healthRouter)
  app.use(statusRouter)
  app.use(tasksRouter)

  app.use(notFound)
  app.use(errorHandler)

  return app
}
