import type { Request, Response, NextFunction } from 'express'
import { createClient } from '@supabase/supabase-js'
import { env } from '../env.js'
import { AppError } from '../util/errors.js'
import { db, profiles } from '../db/index.js'

// Singleton admin client for JWT validation.
const adminClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

// Per-request auth — validates the user's JWT by calling getUser(token).
// Also lazily upserts the profile row on first sign-in so downstream routes
// can assume profiles.id exists.
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    return next(new AppError(401, 'missing bearer token'))
  }
  const token = header.slice(7)
  const { data, error } = await adminClient.auth.getUser(token)
  if (error || !data.user) {
    return next(new AppError(401, 'invalid or expired token'))
  }
  req.user = data.user

  try {
    const meta = (data.user.user_metadata ?? {}) as Record<string, unknown>
    await db
      .insert(profiles)
      .values({
        id: data.user.id,
        github_login: String(meta.user_name ?? meta.preferred_username ?? ''),
        github_user_id: Number(meta.provider_id ?? meta.sub ?? 0),
        budget_reset_date: new Date().toISOString().split('T')[0],
      })
      .onConflictDoNothing()
  } catch (err) {
    return next(err)
  }

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
