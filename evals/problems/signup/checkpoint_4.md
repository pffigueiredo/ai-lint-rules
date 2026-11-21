# Username

The form has a field labelled `Username` whenever the form is on the page, including when `step` is set.

## Availability

When Username is empty, do not request availability. Create account stays enabled. The other field checks still run on submit.

When Username is not empty:

- From the moment it changes until a response for the current value arrives, show `Checking username` and disable Create account.
- 300 ms after the last change, send `GET /api/username?u=<current value>`.
- A further change before those 300 ms are up restarts the wait. Do not send a request for a value that is no longer current.

The JSON is:

	{ "available": true }

or

	{ "available": false }

When the current value is available, show `Username is available` and enable Create account (other field checks still run on submit).

When the current value is taken, show `Username is taken` and keep Create account disabled. A click does not POST.

When the request for the current value fails, show `Could not check username` and keep Create account disabled.

A change to Username hides the previous availability line at once.

## Overlapping responses

A slow response for an older username must not replace a newer one.

Example. The user sets Username to `ada`, waits 300 ms, then sets it to `ada1` and waits 300 ms. The `ada` response returns `{ "available": false }` after the `ada1` request is already in flight. Do not show `Username is taken`. When `ada1` returns `{ "available": true }`, show `Username is available`.

## Submit body

A valid submit sends `username` in the JSON:

	{ "email": "...", "password": "...", "displayName": "...", "username": "..." }
