import type { Request, Response, NextFunction } from 'express'
import { log } from '../log.js'

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export function notFound(_req: Request, res: Response) {
  res.status(404).json({ error: 'not found' })
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.message })
    return
  }
  log.error({ err }, 'unhandled error')
  res.status(500).json({ error: 'internal server error' })
}
