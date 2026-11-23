# Filters and a monthly report

`balances` still works as before. An entry may include `date`, a `YYYY-MM-DD` string. Entries without `date` stay valid. If `date` is present and is not exactly that shape, the file is invalid (exit `3`).

## Account filter

	node src/cli.ts balances FILE --account NAME

Print exactly one line, `NAME BALANCE`, even when `NAME` has no entries. In that case `BALANCE` is `0`. Other flags still apply.

## Date range

	node src/cli.ts balances FILE --from YYYY-MM-DD
	node src/cli.ts balances FILE --to YYYY-MM-DD

`--from` keeps entries whose `date` is on or after that day.
`--to` keeps entries whose `date` is on or before that day.
When either flag is present, drop entries that have no `date`.
`--account` may be combined with the date flags.

If a date range leaves no accounts, print `0 accounts` unless `--account` was set, in which case print `NAME 0`.

## Report

	node src/cli.ts report FILE --month YYYY-MM

Print a JSON object with keys `month`, `accounts`, and `total`:

- `month`: the `YYYY-MM` argument
- `accounts`: an object of account name to summed amount. Keys are sorted ascending. Only accounts with at least one entry in that month.
- `total`: the sum of those amounts

An entry belongs to the month when its `date` is present and starts with `YYYY-MM`.

Missing file, invalid JSON, and invalid entries use the same exit codes as `balances`.

If `--month` is missing, exit `5` and print:

	usage: report --month YYYY-MM
