import { Router } from 'express'
import { and, eq } from 'drizzle-orm'
import { requireAuth } from '../auth.js'
import { db, githubProjects } from '../../db/index.js'
import { listWritableRepos, getProjectFields } from '../../github/createIssue.js'
import { AppError } from '../../util/errors.js'

const router = Router()

router.get('/create-task/repos', requireAuth, async (_req, res) => {
  const repos = await listWritableRepos()
  res.json({ repos })
})

router.get('/create-task/projects/:projectNodeId/fields', requireAuth, async (req, res) => {
  const userId = req.user.id
  const projectNodeId = String(req.params.projectNodeId)

  const [project] = await db
    .select({ id: githubProjects.id })
    .from(githubProjects)
    .where(and(
      eq(githubProjects.user_id, userId),
      eq(githubProjects.project_node_id, projectNodeId),
      eq(githubProjects.enabled, true),
    ))
  if (!project) throw new AppError(404, 'project not enabled for this user')

  const fields = await getProjectFields(projectNodeId)
  res.json({ fields })
})

export default router
