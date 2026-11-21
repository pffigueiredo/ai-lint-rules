# Draft and server field errors

## Draft

Each change to Email, Password, Display name, or Username writes this JSON to `localStorage` under the key `signup-draft`:

	{ "email": "...", "password": "...", "displayName": "...", "username": "..." }

On load, if that key is present and the JSON has those four string fields, fill the fields with those values.

If the key is missing, or the value is not that JSON shape, leave the fields empty and do not show Discard draft.

When a draft is stored, show a button named `Discard draft`. A click removes `signup-draft`, clears the four fields, and hides the button.

A successful create removes `signup-draft`.

## Server field errors

When `POST /api/signup` returns status 422, the JSON is:

	{ "errors": { "email": "Email already used" } }

Keys may be `email`, `password`, `displayName`, and `username`. Show each string next to its field. Keep the form. Do not show `Could not create account`.

Example. A 422 body `{ "errors": { "email": "Email already used", "username": "Pick another username" } }` shows those two lines and no `Could not create account` alert.

Any other non-OK status still shows `Could not create account`, as before.
