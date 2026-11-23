# Profile and password visibility

On load, `GET /api/profile`. If that request fails, keep showing the signup form.

If it succeeds, the JSON is:

	{ "email": "ada@example.com", "displayName": "Ada" }

Show a region named `Profile`. The display name is a heading. The email is text.

## Mode

Buttons `View` and `Edit`. The mode lives in the URL as `mode=view` or `mode=edit`. Missing `mode` means view. Browser back and forward switch the profile between view and edit to match `mode`.

In view, the profile region has no text boxes.

In edit, it has text boxes labelled `Display name` and `Email`, and a button `Save`. `PUT /api/profile` with JSON `{ "email", "displayName" }`. On success, the heading and email text match what was saved. On failure, show an element with role `alert` and the text `Could not save profile`.

## Password visibility

On the signup form, a button `Show password` sits with the password field. Clicking it sets the password input type to `text` and the button name to `Hide password`. Clicking `Hide password` reverses that.
