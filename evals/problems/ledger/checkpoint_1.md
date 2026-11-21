# Account balances

Build a CLI that reads a JSON file of ledger entries and prints one balance per account.

## Run

	node src/cli.ts balances FILE

## File format

FILE is a JSON array. Each item is an object with these fields:

- `id`: a nonempty string
- `account`: a nonempty string
- `amount`: a finite number

Unknown fields are ignored.

## Output

On success, print one line per account that appears in the file, sorted by account name ascending (UTF-16 code units):

	ACCOUNT BALANCE

`ACCOUNT` is the account string. `BALANCE` is the sum of `amount` values for that account. Print a whole number with no decimal point. Print a non-integer with two digits after the decimal point.

If the array is empty, print:

	0 accounts

An account whose amounts sum to zero still appears.

## Exit codes

- `0` printed balances
- `1` FILE does not exist
- `2` FILE is not valid JSON
- `3` FILE is valid JSON but not an array of valid entries: wrong shape, a missing field, an empty `id` or `account`, an `amount` that is not a finite number, or two entries that share an `id`

On a nonzero exit, stdout is empty.
