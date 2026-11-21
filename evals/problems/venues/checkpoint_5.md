# Saved venues

The Save control is a toggle. The header always shows how many venues are saved.

## Saved list

On load, `GET /api/favorites` returns JSON:

	{ "ids": ["v1"] }

`ids` is an array of venue id strings. Duplicates do not count twice.

Until that request succeeds, the header shows `Saved: 0`.

When it succeeds, the header shows `Saved: N` where N is the number of ids.

When it fails, keep `Saved: 0`. The Save button still works.

If the selected venue's id is in `ids`, the details button is `Unsave`. Otherwise it is `Save`.

## Save and unsave

`POST /api/favorites/:id` marks that venue saved.

`DELETE /api/favorites/:id` marks it unsaved.

The click takes effect on the page before the request finishes.

Example. `ids` is empty. The header shows `Saved: 0`. The user clicks Save on Moonlight. The button becomes `Unsave` and the header becomes `Saved: 1` while `POST /api/favorites/v1` is still in flight.

A click on Unsave becomes `Save` and subtracts one from the header while `DELETE /api/favorites/v1` is still in flight.

## Failure

When the request for a click fails, put the button and the header back to what they were before that click.

A failed POST shows an element with role `alert` and the text `Could not save`.

A failed DELETE shows an element with role `alert` and the text `Could not unsave`.

## A second click while a request is in flight

Each click still toggles the button and the header at once, and each click sends its own request. Only the latest click for that venue owns the outcome.

Example. Moonlight is not saved. The user clicks Save, then Unsave, before the POST finishes.

1. After Save, the button is `Unsave` and the header is `Saved: 1`. `POST /api/favorites/v1` is in flight.
2. After Unsave, the button is `Save` and the header is `Saved: 0`. `DELETE /api/favorites/v1` is in flight.
3. The POST then fails. Do not change the button or the header. Do not show an alert.
4. The DELETE then fails. The button becomes `Unsave`, the header becomes `Saved: 1`, and the page shows `Could not unsave`.

If the latest click's request succeeds, keep the button and header from that click. Do not apply an older request that settles afterwards.
