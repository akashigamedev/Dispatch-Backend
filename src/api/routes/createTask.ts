import { Router } from 'express'
import { and, eq } from 'drizzle-orm'
import { requireAuth } from '../auth.js'
import { db, githubProjects } from '../../db/index.js'
import { listWritableRepos, listWritableReposPage, getProjectFields } from '../../github/createIssue.js'
import { AppError } from '../../util/errors.js'

const router = Router()

router.get('/create-task/repos', requireAuth, async (req, res) => {
  const pageParam = req.query.page
  const perPageParam = req.query.perPage
  if (pageParam === undefined && perPageParam === undefined) {
    const repos = await listWritableRepos()
    res.json({ repos })
    return
  }
  const page = Math.max(1, Number(pageParam ?? 1) || 1)
  const perPage = Math.min(100, Math.max(1, Number(perPageParam ?? 10) || 10))
  const { repos, hasMore } = await listWritableReposPage(page, perPage)
  res.json({ repos, page, perPage, hasMore })
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
