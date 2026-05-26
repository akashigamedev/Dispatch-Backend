import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { db, tasks } from '../db/index.js'
import { log } from '../log.js'
import { runTask } from '../worker/run.js'
import { setCurrentTask } from '../worker/cancel.js'

let isRunning = false

export async function runWorkerTick(userId: string): Promise<void> {
  if (isRunning) return

  const [next] = await db
    .select({ id: tasks.id, title: tasks.title })
    .from(tasks)
    .where(and(eq(tasks.user_id, userId), eq(tasks.status, 'queued')))
    .orderBy(
      desc(tasks.priority),
      sql`${tasks.size} asc nulls last`,
      asc(tasks.enqueued_at),
    )
    .limit(1)

  if (!next) return

  isRunning = true
  log.info({ taskId: next.id, title: next.title }, 'worker: starting task')

  runTask(next.id, userId).finally(() => {
    isRunning = false
    setCurrentTask(null)
    // Drain: if more tasks were enqueued while this one ran, the API call that
    // enqueued them returned early (isRunning was still true). Self-trigger so
    // the next queued task starts immediately instead of waiting for the
    // 2-minute safety-net tick.
    runWorkerTick(userId).catch((err) => {
      log.error({ err, userId }, 'worker: follow-up tick failed')
    })
  })
}
