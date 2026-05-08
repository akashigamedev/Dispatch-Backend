import { and, asc, eq } from 'drizzle-orm'
import { db, tasks, taskLogs } from '../db/index.js'
import { log } from '../log.js'

export async function runWorkerTick(userId: string): Promise<void> {
  // Dequeue the highest-priority queued task for this user.
  const [task] = await db
    .select({ id: tasks.id, title: tasks.title })
    .from(tasks)
    .where(and(eq(tasks.user_id, userId), eq(tasks.status, 'queued')))
    .orderBy(
      asc(tasks.manual_order),
      asc(tasks.priority),
      asc(tasks.enqueued_at),
    )
    .limit(1)

  if (!task) return

  log.info({ taskId: task.id, title: task.title }, '[worker stub] would process task — marking done')

  await db
    .update(tasks)
    .set({ status: 'done', started_at: new Date(), finished_at: new Date() })
    .where(eq(tasks.id, task.id))

  await db.insert(taskLogs).values({
    task_id: task.id,
    level: 'info',
    message: '[M4 stub] worker ran — real agent coming in M5',
  })
}
