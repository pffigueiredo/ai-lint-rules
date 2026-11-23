# Task list

Keep tasks in `tasks.json` in the current working directory. If the file is missing, treat that as no tasks.

## Commands

	node src/cli.ts add TITLE
	node src/cli.ts list
	node src/cli.ts done ID

`TITLE` is every argument after `add`, joined with a single space. It must be nonempty. `ID` is a positive integer.

## File format

`tasks.json` is a JSON object:

	{ "tasks": [ { "id": 1, "title": "buy milk", "status": "open" } ] }

`status` is `open` or `done`. `id` values are unique positive integers. The next id is one more than the current maximum, or 1 when there are no tasks. Unknown fields on a task are ignored.

## add

Append a task with status `open`. Print:

	added ID

Create or update `tasks.json`.

## list

If there are no tasks, print:

	0 tasks

Otherwise one line per task, sorted by id ascending:

	ID [open] TITLE
	ID [done] TITLE

## done

Mark that id as done. Print:

	done ID

Unknown id: exit `1`, empty stdout. Already done: still print `done ID` and exit `0`.

## Exit codes

- `0` success
- `1` unknown id for `done`, missing `TITLE` for `add`, or missing `ID` for `done`
- `2` `tasks.json` exists but is not valid JSON
- `3` `tasks.json` is valid JSON but not an object with a valid `tasks` array
- `5` unknown or missing command, stdout:

	usage: add|list|done
