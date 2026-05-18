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
      sql`${tasks.manual_order} asc nulls last`,
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
  })
}
