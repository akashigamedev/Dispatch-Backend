import { Router, type Request, type Response } from 'express'
import { db, profiles } from '../../db/index.js'

const router = Router()

router.get('/health', async (_req: Request, res: Response) => {
  try {
    await db.select({ id: profiles.id }).from(profiles).limit(1)
    res.json({ status: 'ok', ts: new Date().toISOString() })
  } catch (err) {
    res.status(503).json({ status: 'degraded', db: String(err) })
  }
})

export default router
