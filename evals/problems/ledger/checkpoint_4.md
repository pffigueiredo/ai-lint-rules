# Currencies and a rates file

`balances`, `report`, and `import` still work as before. An entry may include `currency`, a string of exactly three uppercase ASCII letters A-Z. Entries without `currency` stay valid and keep the earlier amount rules.

## Amounts

When `currency` is present, `amount` must be an integer JSON number (negative and zero allowed). That integer is a count of minor units of that currency. Every currency in this program has two decimal places, so 1500 USD is 15.00 USD.

When `currency` is absent, `amount` is still a finite JSON number, not necessarily an integer, and it is a count of major units with no currency.

A non-integer `amount` together with `currency` is an invalid entry (exit `3`). A `currency` that is not three uppercase letters is an invalid entry.

## Base currency

	node src/cli.ts balances FILE --base CODE --rates RATES
	node src/cli.ts report FILE --month YYYY-MM --base CODE --rates RATES

`CODE` is three uppercase letters. `RATES` is a JSON file.

`--base` and `--rates` must appear together. If one is present without the other, or `CODE` is not three uppercase letters, exit `5` and print:

	usage: balances --base CODE --rates FILE

For `report`, the same rule uses this line instead:

	usage: report --base CODE --rates FILE

`--account`, `--from`, and `--to` still apply to `balances`. Date filters run first. Then convert. Then sum.

## Rates file

RATES is a JSON array. Each item is an object with:

- `date`: a `YYYY-MM-DD` string
- `from`: three uppercase letters
- `to`: three uppercase letters
- `rate`: a finite number greater than zero. One major unit of `from` equals `rate` major units of `to`.

Unknown fields are ignored. Two rows with the same `date`, `from`, and `to` make the file invalid.

Missing RATES, invalid JSON, and an invalid rates array use exit `1`, `2`, and `3` (empty stdout), the same way `FILE` does.

## Conversion

Work in integer minor units.

- Entry with `currency` equal to `CODE`: `amount` is already minor units of the base.
- Entry with `currency` absent: `amount` is major units of the base. Multiply by 100 and round to an integer with the half-even rule below.
- Entry with `currency` other than `CODE`: `amount` is minor units of that currency. Multiply by the chosen `rate` and round to an integer with the half-even rule. That integer is minor units of the base.

Choose the rate row whose `from` is the entry's `currency`, whose `to` is `CODE`, and whose `date` is the greatest date that is on or before the entry's `date`. Do not invert a row. Do not use a row whose date is after the entry's date.

If `currency` equals `CODE`, do not look up a rate.

An entry with a foreign `currency` and no `date` cannot be converted. An entry with a foreign `currency` and no matching rate row cannot be converted. In either case exit `6` and print nothing.

Convert each matching entry on its own, then sum the rounded minor units per account. Do not sum in the source currency and convert once.

## Half-even rounding

Round a product to the nearest integer. When it is exactly halfway between two integers, pick the even integer.

	1.5 -> 2
	2.5 -> 2
	0.5 -> 0
	-1.5 -> -2
	-2.5 -> -2

Example. Two USD entries of 1 minor unit each, one rate row USD to EUR of 0.5, `--base EUR`. Each product is 0.5, which rounds to 0. The printed EUR total is `0.00`. Converting the sum 2 once would yield 1 and is wrong.

Example. Rates `2024-01-01 USD EUR 0.5` and `2024-01-12 USD EUR 2`. An entry dated `2024-01-10` uses 0.5, not 2.

## Output with `--base`

Print each amount as major units of `CODE` with exactly two digits after the decimal point. 1500 minor units print as `15.00`. A zero balance prints as `0.00`, never `-0.00`.

	ACCOUNT 15.00

`--account NAME` still prints one line. When that name has nothing to sum, print `NAME 0.00`.

`report` with `--base` uses the same conversion. `accounts` values and `total` are JSON numbers equal to minor units divided by 100.

Without `--base`, ignore `currency` and sum `amount` with the earlier rules. `{"amount":1500,"currency":"USD"}` then prints as `1500`.
