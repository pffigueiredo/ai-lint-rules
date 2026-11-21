# Blocking tasks

	node src/cli.ts block ID --on ID

The first id is blocked until the second id is done. Both ids must exist. Print:

	blocked ID on ON

`--on` is required. If it is missing, or either id is missing or not a positive integer, exit `5` and print:

	usage: block ID --on ID

Unknown id: exit `1`, empty stdout.

A task may be blocked on more than one id. Call `block` once per blocker. The same pair may be recorded more than once; print `blocked ID on ON` again.

## Cycles

A cycle is a chain of `block` links that returns to its start, including a task blocked on itself.

	block 1 --on 2
	block 2 --on 1

That second command is a cycle. So is `block 1 --on 1`. So is `1 --on 2`, `2 --on 3`, `3 --on 1`.

On a cycle, do not record the new link. Exit `4` and print:

	cycle

A failed cycle is not undone by `undo`.

## Ready and done

A task is blocked when at least one of its blocker ids refers to a task whose status is `open`. A blocker id that does not refer to a current task is ignored. A blocker whose status is `done` does not block.

	node src/cli.ts list --ready

Print only open tasks that are not blocked. Same line shape and sort as `list`. `--ready` may combine with `--tag` and `--json`. If none match, print `0 tasks`.

`done` on an open blocked task: exit `1` and print `blocked`. Do not change status. Do not spawn a recurring next task. That failed `done` is not undone by `undo`.

A blocked open task still appears in `overdue`. `list --ready` is what hides blocked tasks.

`done` on a task that is already done still prints `done ID` and exits `0`, even if it would be blocked were it open.

## Undo

`undo` reverses the most recent successful `add`, `done`, or `block`. `list`, `overdue`, and `stats` do not count. A spawned recurring task is part of the `done` it came from. Removing a `block` link restores the previous blockers.

`list --json` includes `blockedOn` when that array is nonempty: an array of blocker ids in the order first recorded, without duplicates.
