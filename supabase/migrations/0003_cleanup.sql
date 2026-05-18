-- Cleanup of dead schema after the issue-fetch refactor.
-- Drops unused profile columns, the manual_order queue field, and unused task_status enum values.

-- ── profiles: drop checkin/clockout columns ──────────────────────────────────
alter table profiles drop column if exists active;
alter table profiles drop column if exists checked_in_at;
alter table profiles drop column if exists last_heartbeat_at;

-- ── tasks: drop manual_order and the index that referenced it ────────────────
drop index if exists tasks_queue_idx;
alter table tasks drop column if exists manual_order;
create index if not exists tasks_queue_idx
  on tasks(user_id, status, priority desc, size, enqueued_at);

-- ── task_status enum: drop 'discovered', 'paused', 'skipped' ────────────────
-- Postgres can't drop enum values directly; recreate the type.

-- Coerce any rows still using removed values back to a live value before swap.
update tasks set status = 'queued'  where status in ('discovered', 'paused');
update tasks set status = 'cancelled' where status = 'skipped';

alter type task_status rename to task_status_old;

create type task_status as enum (
  'queued',
  'planning',
  'awaiting_input',
  'coding',
  'verifying',
  'reviewing',
  'pushing',
  'done',
  'failed',
  'cancelled'
);

alter table tasks
  alter column status drop default,
  alter column status type task_status using status::text::task_status,
  alter column status set default 'queued';

drop type task_status_old;
