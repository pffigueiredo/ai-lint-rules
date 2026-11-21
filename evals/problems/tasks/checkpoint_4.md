# Due dates, overdue, and recurrence

`add`, `list`, `done`, `undo`, and `stats` still work as before. The unknown-command usage line is unchanged.

## Due dates

`add` accepts `--due` anywhere after the command.

- `--due YYYY-MM-DD` stores that calendar day. The day must exist in the Gregorian calendar. `2024-02-29` is valid. `2024-02-30` and `2023-02-29` are not.
- `--due +Nd` or `--due +Nw` where `N` is a positive integer. `d` is days. `w` is 7-day weeks, so `+2w` is 14 days. Resolve against `--today YYYY-MM-DD` on the same `add`. `--today` must be a real calendar day. If `--due` is relative and `--today` is missing, or either value is invalid, exit `1` and print nothing.

`--today` is not stored. An absolute `--due` does not need `--today`.

## overdue

	node src/cli.ts overdue --today YYYY-MM-DD

Print open tasks whose due date is strictly before `--today`. Tasks with no due date are omitted. If none match, print `0 tasks`.

Lines use the same `ID [status] TITLE` shape as `list`. Sort by due date ascending, then priority descending, then id ascending.

If `--today` is missing or not a real calendar day, exit `5` and print:

	usage: overdue --today YYYY-MM-DD

## Recurrence

`add` accepts `--every week` or `--every month`. `--every` requires `--due`. Without `--due`, or with any other `--every` value, exit `1` and print nothing.

Completing an open recurring task marks it done and appends a new open task with a new id. The new task copies `title`, tags, priority, and `--every`. It does not copy a done status. Print two lines:

	done ID
	added ID

If the task is already done, print `done ID` as before and do not append another task.

Next due date:

- `week`: add 7 calendar days to the current due date.
- `month`: use the day-of-month of the `--due` value given at `add` time. The next due date is that day in the month after the current due date's month, clamped to that month's last calendar day. February has 29 days in a leap year and 28 otherwise. A year is a leap year when it is divisible by 4, except years divisible by 100 but not by 400.

	`--due 2024-01-31 --every month`, then `done`, then `done` on the new task
	-> first next due is `2024-02-29`, second is `2024-03-31`

	`--due 2024-02-27 --every week`, then `done`
	-> next due is `2024-03-05`

`undo` reverses a `done` that spawned a task: the original task is open again and the spawned task is gone.

`list --json` includes `due` (a `YYYY-MM-DD` string) and `every` (`week` or `month`) only when that task has them.
