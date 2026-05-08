-- Enable pgcrypto for gen_random_uuid
create extension if not exists pgcrypto;

-- ── Enums ────────────────────────────────────────────────────────────────────

create type task_status as enum (
  'queued',
  'paused',
  'planning',
  'awaiting_input',
  'coding',
  'verifying',
  'reviewing',
  'pushing',
  'done',
  'failed',
  'cancelled',
  'skipped'
);

create type task_size as enum ('XS', 'S', 'M', 'L', 'XL');

-- ── profiles ─────────────────────────────────────────────────────────────────

create table profiles (
  id                    uuid primary key references auth.users(id) on delete cascade,
  github_login          text not null,
  github_user_id        bigint not null unique,
  github_installation_id bigint,
  active                boolean not null default false,
  checked_in_at         timestamptz,
  last_heartbeat_at     timestamptz,
  work_start_local      time not null default '10:00',
  work_end_local        time not null default '19:00',
  timezone              text not null default 'Asia/Kolkata',
  daily_budget_usd      numeric(8,2) not null default 5.00,
  spent_today_usd       numeric(8,2) not null default 0.00,
  budget_reset_date     date not null default current_date,
  models                jsonb not null default '{
    "planner":  {"id": "claude-opus-4-7",  "thinking": "medium"},
    "sizer":    {"id": "claude-opus-4-7",  "thinking": "low"},
    "coder":    {"id": "claude-sonnet-4-6","thinking": "low"},
    "reviewer": {"id": "claude-opus-4-7",  "thinking": "low"}
  }'::jsonb,
  created_at            timestamptz not null default now()
);

alter table profiles enable row level security;
create policy "profiles: own row only" on profiles
  using (auth.uid() = id);

-- ── github_projects ───────────────────────────────────────────────────────────

create table github_projects (
  id               bigserial primary key,
  user_id          uuid not null references profiles(id) on delete cascade,
  project_node_id  text not null,
  project_number   int not null,
  owner_login      text not null,
  title            text not null,
  enabled          boolean not null default true,
  unique(user_id, project_node_id)
);

alter table github_projects enable row level security;
create policy "github_projects: own rows only" on github_projects
  using (auth.uid() = user_id);

-- ── repos ─────────────────────────────────────────────────────────────────────

create table repos (
  id              bigserial primary key,
  user_id         uuid not null references profiles(id) on delete cascade,
  full_name       text not null,
  github_repo_id  bigint not null,
  base_branch     text not null default 'dev',
  branch_prefix   text not null default 'nightowl/',
  allowed         boolean not null default true,
  unique(user_id, github_repo_id)
);

alter table repos enable row level security;
create policy "repos: own rows only" on repos
  using (auth.uid() = user_id);

-- ── tasks ─────────────────────────────────────────────────────────────────────

create table tasks (
  id                    bigserial primary key,
  user_id               uuid not null references profiles(id) on delete cascade,
  repo_id               bigint references repos(id) on delete set null,
  github_issue_node_id  text not null,
  github_issue_number   int not null,
  github_issue_url      text not null,
  title                 text not null,
  body                  text,
  size                  task_size,
  priority              int not null default 0,
  manual_order          int,
  status                task_status not null default 'queued',
  branch_name           text,
  pr_url                text,
  pr_number             int,
  plan_md               text,
  diff_summary          text,
  failure_reason        text,
  cost_usd              numeric(8,4) not null default 0,
  tokens_in             bigint not null default 0,
  tokens_out            bigint not null default 0,
  enqueued_at           timestamptz not null default now(),
  started_at            timestamptz,
  finished_at           timestamptz,
  unique(user_id, github_issue_node_id)
);

alter table tasks enable row level security;
create policy "tasks: own rows only" on tasks
  using (auth.uid() = user_id);

create index tasks_queue_idx
  on tasks(user_id, status, manual_order nulls last, priority desc, size, enqueued_at);

-- ── task_logs ─────────────────────────────────────────────────────────────────

create table task_logs (
  id       bigserial primary key,
  task_id  bigint not null references tasks(id) on delete cascade,
  ts       timestamptz not null default now(),
  level    text not null check (level in ('info','warn','error','cmd','claude')),
  message  text not null,
  meta     jsonb
);

alter table task_logs enable row level security;
create policy "task_logs: task owner only" on task_logs
  using (
    exists (
      select 1 from tasks t
      where t.id = task_logs.task_id
        and t.user_id = auth.uid()
    )
  );

create index task_logs_task_idx on task_logs(task_id, ts);
