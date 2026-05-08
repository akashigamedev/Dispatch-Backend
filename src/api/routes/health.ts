import { Router, type Request, type Response } from 'express'
import { db } from '../../db.js'

const router = Router()

router.get('/health', async (_req: Request, res: Response) => {
  // Verify DB connectivity on every health check.
  const { error } = await db.from('profiles').select('id').limit(1)
  if (error) {
    res.status(503).json({ status: 'degraded', db: error.message })
    return
  }
  res.json({ status: 'ok', ts: new Date().toISOString() })
})

export default router
