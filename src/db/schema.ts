import {
  pgTable,
  pgEnum,
  uuid,
  text,
  boolean,
  timestamp,
  numeric,
  jsonb,
  bigserial,
  bigint,
  integer,
  index,
  unique,
} from 'drizzle-orm/pg-core'

export const taskStatusEnum = pgEnum('task_status', [
  'queued',
  'planning',
  'awaiting_input',
  'coding',
  'verifying',
  'reviewing',
  'pushing',
  'done',
  'failed',
  'cancelled',
])

export const taskSizeEnum = pgEnum('task_size', ['XS', 'S', 'M', 'L', 'XL'])

// profiles.id references auth.users(id) — FK managed at DB level, not in Drizzle
// (auth schema is owned by Supabase)
export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey(),
  github_login: text('github_login').notNull(),
  github_user_id: bigint('github_user_id', { mode: 'number' }).notNull(),
  // reserved for future GitHub App mode; PAT mode does not populate this
  github_installation_id: bigint('github_installation_id', { mode: 'number' }),
  anthropic_resume_after: timestamp('anthropic_resume_after', { withTimezone: true }),
  models: jsonb('models').notNull().default({
    planner: { id: 'claude-opus-4-7', thinking: 'medium' },
    sizer: { id: 'claude-opus-4-7', thinking: 'low' },
    coder: { id: 'claude-sonnet-4-6', thinking: 'medium' },
    reviewer: { id: 'claude-opus-4-7', thinking: 'low' },
  }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const githubProjects = pgTable(
  'github_projects',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    user_id: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    project_node_id: text('project_node_id').notNull(),
    project_number: integer('project_number').notNull(),
    owner_login: text('owner_login').notNull(),
    title: text('title').notNull(),
    enabled: boolean('enabled').notNull().default(true),
  },
  (t) => [unique().on(t.user_id, t.project_node_id)],
)

export const repos = pgTable(
  'repos',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    user_id: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    full_name: text('full_name').notNull(),
    github_repo_id: bigint('github_repo_id', { mode: 'number' }).notNull(),
    base_branch: text('base_branch').notNull().default('dev'),
    branch_prefix: text('branch_prefix').notNull().default('fix/'),
  },
  (t) => [unique().on(t.user_id, t.github_repo_id)],
)

export const tasks = pgTable(
  'tasks',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    user_id: uuid('user_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    // 'single' = legacy issue-driven flow; 'multi' = new multi-repo flow (1+ repos, issues
    // created only at the end). For 'multi', repo_id and github_issue_* are NULL and the
    // per-repo state lives in the `repos` JSON column.
    kind: text('kind').notNull().default('single'),
    repo_id: bigint('repo_id', { mode: 'number' }).references(() => repos.id, {
      onDelete: 'set null',
    }),
    github_issue_node_id: text('github_issue_node_id'),
    github_issue_number: integer('github_issue_number'),
    github_issue_url: text('github_issue_url'),
    github_project_node_id: text('github_project_node_id'),
    // For multi tasks: where the eventual Code Review issues are created.
    project_node_id_target: text('project_node_id_target'),
    // For multi tasks: user-supplied free-form description (replaces issue body).
    description: text('description'),
    // For multi tasks: shared contract / API spec emitted by the planner.
    contract_md: text('contract_md'),
    // For multi tasks: per-repo state. Shape: TaskRepoEntry[] (see types/multiRepo.ts).
    repos: jsonb('repos'),
    title: text('title').notNull(),
    body: text('body'),
    size: taskSizeEnum('size'),
    priority: integer('priority').notNull().default(0),
    status: taskStatusEnum('status').notNull().default('queued'),
    branch_name: text('branch_name'),
    pr_url: text('pr_url'),
    pr_number: integer('pr_number'),
    plan_md: text('plan_md'),
    diff_summary: text('diff_summary'),
    failure_reason: text('failure_reason'),
    revision_feedback: text('revision_feedback'),
    cost_usd: numeric('cost_usd', { precision: 8, scale: 4 }).notNull().default('0'),
    tokens_in: bigint('tokens_in', { mode: 'number' }).notNull().default(0),
    tokens_out: bigint('tokens_out', { mode: 'number' }).notNull().default(0),
    enqueued_at: timestamp('enqueued_at', { withTimezone: true }).notNull().defaultNow(),
    started_at: timestamp('started_at', { withTimezone: true }),
    finished_at: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    unique().on(t.user_id, t.github_issue_node_id),
    index('tasks_queue_idx').on(
      t.user_id,
      t.status,
      t.priority,
      t.size,
      t.enqueued_at,
    ),
  ],
)

export const taskLogs = pgTable(
  'task_logs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    task_id: bigint('task_id', { mode: 'number' })
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    level: text('level').notNull(),
    message: text('message').notNull(),
    meta: jsonb('meta'),
  },
  (t) => [index('task_logs_task_idx').on(t.task_id, t.ts)],
)
