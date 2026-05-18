-- Drop work-window and budget columns from profiles.
-- Worker no longer gates on time-of-day or daily spend; per-task cost
-- remains on tasks.cost_usd.

alter table profiles drop column if exists work_start_local;
alter table profiles drop column if exists work_end_local;
alter table profiles drop column if exists timezone;
alter table profiles drop column if exists budget_enabled;
alter table profiles drop column if exists daily_budget_usd;
alter table profiles drop column if exists spent_today_usd;
alter table profiles drop column if exists budget_reset_date;
