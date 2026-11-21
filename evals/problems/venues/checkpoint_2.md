# Search, open filter, and sort

The list from before still works. Filters people share live in the URL query string and are restored on load.

## Search

A text box labelled `Search`. Its value is the `q` query param (empty when the param is missing). Typing updates `q` in the URL. An empty search removes `q`.

Keep a venue when `q` is empty, or when the name or city contains `q` (case-insensitive).

## Open now

A checkbox labelled `Open now`. It is checked when the URL has `open=1`, unchecked otherwise. Checking it sets `open=1`. Unchecking it removes `open`.

When it is checked, keep only venues whose `open` field is true.

## Sort

A dropdown labelled `Sort` with options `Name` and `City`. The URL param `sort` is `name` or `city`. Missing `sort` means `name`. Changing the dropdown updates `sort` in the URL.

Sort the visible list by that field, ascending, using UTF-16 code units. Break ties by `id` ascending.
