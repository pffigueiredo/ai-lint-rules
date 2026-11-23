# Undo and stats

	node src/cli.ts undo
	node src/cli.ts stats

`undo` reverses the most recent successful `add` or `done`. `list` does not count. Print `undone` and restore the tasks to the state before that command. If there is nothing to reverse, exit `1` and print:

	nothing to undo

`stats` prints two lines:

	open N
	done M

`N` and `M` are counts of current tasks in those statuses.

The usage line for an unknown command is now:

	usage: add|list|done|undo|stats
