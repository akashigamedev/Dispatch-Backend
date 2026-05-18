-- Migration: add 'discovered' task status and project association to tasks.
-- 'discovered' is the initial state for issues polled from GitHub but not yet
-- started by the user via the Start button.

alter type task_status add value if not exists 'discovered' before 'queued';

alter table tasks
  add column if not exists github_project_node_id text;

create index if not exists tasks_user_project_status_idx
  on tasks(user_id, github_project_node_id, status);
