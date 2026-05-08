import express from 'express'
import { notFound, errorHandler } from '../util/errors.js'
import healthRouter from './routes/health.js'

export function createServer() {
  const app = express()

  app.use(express.json())

  app.use(healthRouter)

  // Authenticated routes added in later milestones.

  app.use(notFound)
  app.use(errorHandler)

  return app
}
