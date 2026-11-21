# Import CSV rows

	node src/cli.ts import LEDGER ROWS

`LEDGER` is the JSON file from the earlier commands. `ROWS` is a CSV file.

## CSV

UTF-8 text. The first line must be exactly:

	id,account,amount,date

Each later line is `id,account,amount,date` with no quoted fields and no extra commas. `amount` is a finite number. `date` is `YYYY-MM-DD`. `id` and `account` are nonempty.

## Behavior

Read `LEDGER` with the same checks as `balances`. An empty array is allowed.

For each CSV row in order:

- if `id` already exists in `LEDGER`, or was already imported in this run, skip it
- otherwise append `{ "id", "account", "amount", "date" }`

Write `LEDGER` as `JSON.stringify(entries, null, 2)` plus a trailing newline. Store `amount` as a JSON number. Imported rows always have `date`. Existing rows keep the fields they already had.

Print one line:

	imported N skipped M

`N` is the number appended. `M` is the number skipped.

## Exit codes

- `0` wrote `LEDGER`
- `1` `LEDGER` or `ROWS` does not exist
- `2` / `3` `LEDGER` fails the same JSON and entry checks as `balances`
- `4` `ROWS` is not a valid CSV of this form: bad header, wrong field count, empty `id` or `account`, `amount` not a finite number, or `date` not `YYYY-MM-DD`
