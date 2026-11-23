# Tags and priority

`add` accepts flags anywhere after the command:

- `--tag TAG` may appear more than once. `TAG` is nonempty. Store tags in the order they appear, dropping later duplicates.
- `--priority N` where `N` is an integer (negative allowed). Default `0` when omitted.

	node src/cli.ts add TITLE --tag work --priority 2

`list` still prints `ID [status] TITLE`. Sort by priority descending, then id ascending. A stored task with no `priority` counts as `0`. A stored task with no `tags` counts as no tags.

	node src/cli.ts list --tag TAG

Only tasks that have that tag. If none match, print `0 tasks`.

	node src/cli.ts list --json

Print a JSON array of objects with keys `id`, `title`, `status`, `priority`, `tags`. `tags` is an array of strings. Same sort as `list`. `--json` may combine with `--tag`.
