import 'dotenv/config'
import { setDefaultResultOrder } from 'dns'
setDefaultResultOrder('ipv4first') // many home networks can't route to Supabase's AAAA record
import './env.js' // validate env first — exits on invalid config
import { eq, inArray } from 'drizzle-orm'
import { createServer } from './api/server.js'
import { db, profiles, tasks } from './db/index.js'
import { env } from './env.js'
import { log } from './log.js'
import { sizeUnsizedTasks, requeueStaleAwaitingInput } from './scheduler/poller.js'
import { runWorkerTick } from './scheduler/worker.js'
import { isWithinWorkWindow } from './scheduler/window.js'
import { resetBudgetIfNewDay, isBudgetExceeded } from './scheduler/budget.js'

const IN_FLIGHT_STATUSES = ['planning', 'coding', 'verifying', 'reviewing', 'pushing'] as const
const ACTIONABLE_STATUSES = ['queued', 'awaiting_input', ...IN_FLIGHT_STATUSES] as const

async function recoverInterruptedTasks(): Promise<void> {
  const recovered = await db
    .update(tasks)
    .set({ status: 'failed', failure_reason: 'interrupted', finished_at: new Date() })
    .where(inArray(tasks.status, [...IN_FLIGHT_STATUSES]))
    .returning({ id: tasks.id })

  if (recovered.length > 0) {
    log.warn({ count: recovered.length }, 'boot: marked interrupted in-flight tasks as failed')
  }
}

const app = createServer()

app.listen(env.PORT, () => {
  log.info({ port: env.PORT, env: env.NODE_ENV }, 'nightowl server started')
})

recoverInterruptedTasks().catch((err) => log.error({ err }, 'boot recovery error'))

/**
 * Background safety-net tick. The primary trigger is Start (which calls runWorkerTick directly);
 * this just catches stalled awaiting_input, sizes any unsized queued tasks, and re-kicks the worker
 * for users whose rate-limit hold has expired.
 */
export async function tick(): Promise<void> {
  const usersWithWork = await db
    .selectDistinct({
      id: profiles.id,
      work_start_local: profiles.work_start_local,
      work_end_local: profiles.work_end_local,
      timezone: profiles.timezone,
      anthropic_resume_after: profiles.anthropic_resume_after,
    })
    .from(profiles)
    .innerJoin(tasks, eq(tasks.user_id, profiles.id))
    .where(inArray(tasks.status, [...ACTIONABLE_STATUSES]))

  for (const user of usersWithWork) {
    if (!isWithinWorkWindow(user)) continue
    if (user.anthropic_resume_after && user.anthropic_resume_after > new Date()) continue

    try {
      await resetBudgetIfNewDay(user.id)
      if (await isBudgetExceeded(user.id)) {
        log.info({ userId: user.id }, 'daily budget exceeded — skipping tick')
        continue
      }

      await requeueStaleAwaitingInput(user.id)
      await sizeUnsizedTasks(user.id)
      await runWorkerTick(user.id)
    } catch (err) {
      log.error({ err, userId: user.id }, 'tick error')
    }
  }
}

const TICK_INTERVAL_MS = 2 * 60 * 1000
tick().catch((err) => log.error({ err }, 'tick error'))
setInterval(() => {
  tick().catch((err) => log.error({ err }, 'tick error'))
}, TICK_INTERVAL_MS)
