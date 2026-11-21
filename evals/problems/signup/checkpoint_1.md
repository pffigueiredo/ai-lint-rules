# Create account

The default export of `src/App.tsx` is the app.

## Form

A form with three labelled fields and a submit button:

- `Email`
- `Password`, with input type `password`
- `Display name`
- button `Create account`

## Checks on submit

If a field is wrong, do not POST. Show these messages next to the form:

- Email is empty or has no `@`: `Enter an email`
- Password is shorter than 8 characters: `Password must be at least 8 characters`
- Display name is empty: `Enter a display name`

Several messages may show at once.

## Request

A valid submit sends `POST /api/signup` with JSON:

	{ "email": "...", "password": "...", "displayName": "..." }

On an OK response, hide the form and show `Account created`.

On a non-OK response, keep the form and show an element with role `alert` and the text `Could not create account`. Do not retry a failed request.
