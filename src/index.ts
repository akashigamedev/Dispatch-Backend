import 'dotenv/config'
import './env.js' // validate env first — exits on invalid config
import { eq } from 'drizzle-orm'
import { createServer } from './api/server.js'
import { db, profiles } from './db/index.js'
import { env } from './env.js'
import { log } from './log.js'
import { pollProjects } from './scheduler/poller.js'
import { runWorkerTick } from './scheduler/worker.js'
import { isWithinWorkWindow } from './scheduler/window.js'

const app = createServer()

app.listen(env.PORT, () => {
  log.info({ port: env.PORT, env: env.NODE_ENV }, 'nightowl server started')
})

async function tick(): Promise<void> {
  if (!isWithinWorkWindow()) {
    log.debug('outside work window — skipping tick')
    return
  }

  // Find all active users and run poller + worker for each.
  const activeUsers = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.active, true))

  if (activeUsers.length === 0) return

  for (const user of activeUsers) {
    try {
      await pollProjects(user.id)
      await runWorkerTick(user.id)
    } catch (err) {
      log.error({ err, userId: user.id }, 'tick error')
    }
  }
}

const TICK_INTERVAL_MS = 2 * 60 * 1000
setInterval(() => {
  tick().catch((err) => log.error({ err }, 'tick error'))
}, TICK_INTERVAL_MS)
