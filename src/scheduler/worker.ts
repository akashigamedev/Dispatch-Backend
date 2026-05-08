import { and, asc, eq } from 'drizzle-orm'
import { db, tasks, taskLogs } from '../db/index.js'
import { log } from '../log.js'

export async function runWorkerTick(userId: string): Promise<void> {
  // Stub drains all queued tasks per tick. Real M6 worker processes one at a time.
  const queued = await db
    .select({ id: tasks.id, title: tasks.title })
    .from(tasks)
    .where(and(eq(tasks.user_id, userId), eq(tasks.status, 'queued')))
    .orderBy(asc(tasks.manual_order), asc(tasks.priority), asc(tasks.enqueued_at))

  if (queued.length === 0) return

  log.info({ count: queued.length }, '[worker stub] draining queued tasks')

  for (const task of queued) {
    await db
      .update(tasks)
      .set({ status: 'done', started_at: new Date(), finished_at: new Date() })
      .where(eq(tasks.id, task.id))

    await db.insert(taskLogs).values({
      task_id: task.id,
      level: 'info',
      message: '[stub] worker ran — real agent coming in M6',
    })
  }
}
