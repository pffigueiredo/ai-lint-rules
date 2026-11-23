# Recurring monthlies and a budget

An entry may include `every` and `day`. When `every` is present it must be the string `month`, `day` must be an integer from 1 through 31, and `date` must be present. That entry is a template, not a posted amount. Any other combination of those fields is an invalid entry (exit `3`).

Templates are left out of `balances` and `report` unless they are expanded, as below. They are never written out as extra rows. `import` still only appends CSV rows.

An entry may include `category`, a nonempty string. An empty `category` is invalid.

## Expansion

A template fires once per calendar month on `day`, starting at its own `date`. If that month is shorter than `day`, fire on the month's last calendar day instead. February in a leap year has 29 days. February in a common year has 28. A year is a leap year when it is divisible by 4, except years divisible by 100 but not by 400.

	day 31, date 2024-01-31, window 2024-01-31 through 2024-04-30
	-> 2024-01-31, 2024-02-29, 2024-03-31, 2024-04-30

	day 31, date 2023-01-31, window 2023-01-31 through 2023-03-31
	-> 2023-01-31, 2023-02-28, 2023-03-31

	day 29, date 2024-02-01, window 2024-02-01 through 2025-02-28
	-> 2024-02-29, then the 29th of each later month, and 2025-02-28

Each firing is a virtual posted entry with the template's `account`, `amount`, `currency`, and `category`, and with `date` set to the firing day. Apply the same date filters, conversion, and summing as for posted entries. Conversion uses that firing day, not the template's `date`.

`balances` expands templates only when both `--from` and `--to` are set. The window is those two days, inclusive. A firing before the template `date`, before `--from`, or after `--to` is dropped.

If only `--from` or only `--to` is set, skip every template and filter posted entries as before.

	--from 2024-01-15 --to 2024-03-15, day 20
	-> 2024-01-20, 2024-02-20
	(2024-03-20 is after --to)

	--from 2024-01-15 --to 2024-03-15, day 10
	-> 2024-02-10, 2024-03-10
	(2024-01-10 is before --from)

`report --month YYYY-MM` expands into that calendar month (the 1st through its last day). Posted entries still belong to the month when their `date` starts with `YYYY-MM`.

## Budget

	node src/cli.ts budget FILE --month YYYY-MM --limits LIMITS

`LIMITS` is a JSON object. Each key is a category name. Each value is a finite number greater than or equal to zero, in the same units as `spent` below.

Spend for a category in that month is the sum of `-amount` over posted entries and expanded firings whose `category` is that key, whose `date` falls in the month, and whose `amount` is negative. Positive amounts in that category do not reduce spend. Entries with no `category` are omitted.

When `--base` and `--rates` are also set, convert each of those entries first, using the currency rules, then take spend from the converted minor units divided by 100. `--base` and `--rates` must still appear together. If one is present without the other, exit `5` and print:

	usage: budget --base CODE --rates FILE

Print a JSON object with keys `month` and `categories`. `categories` has one key per key in LIMITS, sorted by name ascending, each value an object:

- `spent`: the spend for that category, or `0` when none
- `limit`: the LIMITS value
- `ok`: `true` when `spent` is less than or equal to `limit`, otherwise `false`

A LIMITS key with no spend still appears with `spent` 0. A category that has spend but is not a LIMITS key is omitted.

If `--month` or `--limits` is missing, exit `5` and print:

	usage: budget --month YYYY-MM --limits FILE

Missing LIMITS, invalid JSON, and a LIMITS value that is not an object of finite numbers greater than or equal to zero use exit `1`, `2`, and `4` (empty stdout). Missing FILE, invalid JSON, and invalid entries use `1`, `2`, and `3` as before.
