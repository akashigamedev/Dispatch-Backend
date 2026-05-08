import type { Request, Response, NextFunction } from 'express'
import { createClient } from '@supabase/supabase-js'
import { env } from '../env.js'
import { AppError } from '../util/errors.js'

// Per-request anon client validates the user's JWT from the app.
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    return next(new AppError(401, 'missing bearer token'))
  }
  const token = header.slice(7)
  const client = createClient(env.SUPABASE_URL, token, {
    auth: { persistSession: false },
  })
  const { data, error } = await client.auth.getUser()
  if (error || !data.user) {
    return next(new AppError(401, 'invalid or expired token'))
  }
  req.user = data.user
  next()
}

// Extend Express Request with the authenticated user.
declare global {
  namespace Express {
    interface Request {
      user: import('@supabase/supabase-js').User
    }
  }
}
