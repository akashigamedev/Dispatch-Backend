// Shape of each entry in tasks.repos (jsonb) for multi-repo tasks.
// Stored as JSON; not a Drizzle table. Mutated in-place by the worker as phases progress.

export type RepoPhaseStatus =
  | 'pending'
  | 'planning'
  | 'coding'
  | 'verifying'
  | 'reviewing'
  | 'pushing'
  | 'done'
  | 'failed'

export interface TaskRepoEntry {
  repo_id: number
  full_name: string
  base_branch: string
  // repo_ids of upstream dependencies — must reach 'done' before this repo enters 'coding'.
  depends_on: number[]
  status: RepoPhaseStatus

  // populated by planner
  plan_md?: string
  files_to_touch?: string[]
  branch_slug?: string
  change_type?: string
  commit_title?: string
  commit_body?: string

  // populated by worker as phases progress
  branch_name?: string
  diff_summary?: string
  pr_url?: string
  pr_number?: number
  issue_node_id?: string
  issue_number?: number
  issue_url?: string
  failure_reason?: string
}
