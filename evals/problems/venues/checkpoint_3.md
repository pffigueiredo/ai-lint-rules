# Venue details and save

Clicking a venue name in the list opens its details. The selected id lives in the URL as `venue`. Other query params stay.

When `venue` is missing, do not show the details region.

## Details

`GET /api/venues/:id` returns JSON:

	{
	  "id": "v1",
	  "name": "Moonlight",
	  "city": "Lisbon",
	  "open": true,
	  "description": "Rooftop in Bairro Alto.",
	  "hours": "22:00-04:00"
	}

While that request is in flight, show `Loading venue` inside a region named `Venue details`.

On success, that region contains:

- a heading with the venue name
- the description
- the hours
- a button `Save`

When that request fails, show an element with role `alert` and the text `Could not load venue`.

## Save

`POST /api/favorites` with JSON body `{ "venueId": "<id>" }`.

On success, replace the button with the text `Saved`.
On failure, show an element with role `alert` and the text `Could not save`.
