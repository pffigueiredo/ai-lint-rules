# Steps

When the URL has `step`, show one field at a time:

- `step=1`: Email and a `Next` button
- `step=2`: Password, the show/hide control, and `Back` plus `Next`
- `step=3`: Display name, `Back`, and `Create account`

`Next` writes the next step to the URL. `Back` writes the previous step. Other query params stay.

Without `step`, show every field and `Create account` as before.

Submit still uses the same checks and `POST /api/signup`.
