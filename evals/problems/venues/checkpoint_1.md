# Venue list

The default export of `src/App.tsx` is the app.

## Data

`GET /api/venues` returns JSON:

	{
	  "venues": [
	    { "id": "v1", "name": "Moonlight", "city": "Lisbon", "open": true }
	  ]
	}

`id`, `name`, and `city` are nonempty strings. `open` is true or false.

## UI

While that request is in flight, show the text `Loading venues`.

When it succeeds, show a list. Each venue is a list item. Show the name and the city. The name is a button whose accessible name is the venue name.

When `venues` is an empty array, show `No venues` and no list items.

When the request fails (a non-OK status or a network failure), show an element with role `alert` and the text `Could not load venues`. Do not retry a failed request.
