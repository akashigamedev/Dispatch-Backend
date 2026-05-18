import { Router } from 'express'
import { eq } from 'drizzle-orm'
import { requireAuth } from '../auth.js'
import { db, profiles } from '../../db/index.js'
import { syncProjectsForUser } from '../../github/projectsSync.js'
import { log } from '../../log.js'

const router = Router()

router.post('/checkin', requireAuth, async (req, res) => {
  const userId = req.user.id
  const now = new Date()

  await db
    .update(profiles)
    .set({ active: true, checked_in_at: now, last_heartbeat_at: now, anthropic_resume_after: null })
    .where(eq(profiles.id, userId))

  log.info({ userId }, 'user checked in')

  try {
    await syncProjectsForUser(userId)
  } catch (err) {
    log.error({ err, userId }, 'projects sync failed on checkin')
  }

  res.json({ active: true, checkedInAt: now.toISOString() })
})

router.post('/checkout', requireAuth, async (req, res) => {
  const userId = req.user.id

  await db
    .update(profiles)
    .set({ active: false })
    .where(eq(profiles.id, userId))

  log.info({ userId }, 'user checked out')
  res.json({ active: false })
})

router.post('/heartbeat', requireAuth, async (req, res) => {
  const userId = req.user.id

  await db
    .update(profiles)
    .set({ last_heartbeat_at: new Date() })
    .where(eq(profiles.id, userId))

  res.json({ ok: true })
})

export default router
