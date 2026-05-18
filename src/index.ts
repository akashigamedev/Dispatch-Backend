import 'dotenv/config'
import { setDefaultResultOrder } from 'dns'
setDefaultResultOrder('ipv4first') // many home networks can't route to Supabase's AAAA record
import './env.js' // validate env first — exits on invalid config
import { and, eq, inArray, isNotNull, lt, lte } from 'drizzle-orm'
import { createServer } from './api/server.js'
import { db, profiles, tasks } from './db/index.js'
import { env } from './env.js'
import { log } from './log.js'
import { pollProjects, sizeUnsizedTasks, requeueStaleAwaitingInput } from './scheduler/poller.js'
import { runWorkerTick } from './scheduler/worker.js'
import { isWithinWorkWindow } from './scheduler/window.js'
import { resetBudgetIfNewDay, isBudgetExceeded } from './scheduler/budget.js'

const IN_FLIGHT_STATUSES = ['planning', 'coding', 'verifying', 'reviewing', 'pushing'] as const

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

async function checkHeartbeatTimeouts(): Promise<void> {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000)
  const timedOut = await db
    .update(profiles)
    .set({ active: false })
    .where(and(eq(profiles.active, true), lt(profiles.last_heartbeat_at, cutoff)))
    .returning({ id: profiles.id })

  for (const u of timedOut) {
    log.info({ userId: u.id }, 'heartbeat timeout — auto checkout')
  }
}

/** Re-activate users who were auto-checked-out by a rate limit and whose resume time has passed. */
async function autoResumeRateLimited(): Promise<void> {
  const now = new Date()
  const resumed = await db
    .update(profiles)
    .set({ active: true, anthropic_resume_after: null })
    .where(and(
      eq(profiles.active, false),
      isNotNull(profiles.anthropic_resume_after),
      lte(profiles.anthropic_resume_after, now),
    ))
    .returning({ id: profiles.id })

  for (const u of resumed) {
    log.info({ userId: u.id }, 'Anthropic rate limit cleared — auto clock-in')
  }
}

const app = createServer()

app.listen(env.PORT, () => {
  log.info({ port: env.PORT, env: env.NODE_ENV }, 'nightowl server started')
})

recoverInterruptedTasks().catch((err) => log.error({ err }, 'boot recovery error'))

async function tick(): Promise<void> {
  await checkHeartbeatTimeouts()
  await autoResumeRateLimited()

  const activeUsers = await db
    .select({
      id: profiles.id,
      work_start_local: profiles.work_start_local,
      work_end_local: profiles.work_end_local,
      timezone: profiles.timezone,
    })
    .from(profiles)
    .where(eq(profiles.active, true))

  if (activeUsers.length === 0) return

  for (const user of activeUsers) {
    if (!isWithinWorkWindow(user)) {
      log.info({ userId: user.id }, 'work window ended — auto checkout')
      await db.update(profiles).set({ active: false }).where(eq(profiles.id, user.id))
      continue
    }

    try {
      await resetBudgetIfNewDay(user.id)

      if (await isBudgetExceeded(user.id)) {
        log.info({ userId: user.id }, 'daily budget exceeded — skipping tick')
        continue
      }

      await requeueStaleAwaitingInput(user.id)
      await pollProjects(user.id)
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
