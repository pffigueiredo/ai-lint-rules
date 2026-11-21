# Server search and paging

Search now asks the server. Open now and Sort still apply to the venues already on the page.

## List request

`GET /api/venues?q=<text>&page=<n>` returns JSON:

	{
	  "venues": [
	    { "id": "v1", "name": "Moonlight", "city": "Lisbon", "open": true }
	  ],
	  "nextPage": 2
	}

`page` is a 1-based integer. The first request for a Search value uses `page=1`.

`q` is the Search box value. When Search is empty, omit `q`.

`nextPage` is the next 1-based page number, or `null` when there is no further page.

A missing `nextPage` field also means there is no further page.

## Search

Each time the Search value changes, request page 1 for that `q`.

`q` stays in the URL, as before, and a load with `q` in the URL requests that value.

Example. Search is empty and the page shows Moonlight, Harbor, and Atlas. The user sets Search to `lis`. The next list request is `GET /api/venues?q=lis&page=1`. When it returns only Moonlight, Harbor and Atlas leave the list.

## Overlapping responses

A slow response for an older Search value must not replace a newer one.

Example. Search changes from `li` to `lis`. The `lis` response returns first, with only Moonlight. The list shows Moonlight. Then the `li` response returns, with Moonlight and Atlas. The list still shows only Moonlight. Atlas stays hidden.

While a newer Search request is in flight, keep showing the previous Search venues. Do not show Load more until the current Search page 1 has arrived.

## Load more

When `nextPage` is a number, show a button named `Load more`. When `nextPage` is `null` or missing, do not show that button.

A click requests `GET /api/venues` with the current `q` and `page` set to that `nextPage`. Append the returned venues to the list already on the page.

Example. Page 1 for empty Search returns Moonlight and `nextPage` 2. The list shows Moonlight and a Load more button. A click requests `GET /api/venues?page=2`. That response returns Harbor and `nextPage` `null`. The list shows Moonlight and Harbor. Load more is gone.

A new Search value drops previously loaded pages. It does not append to them.

Do not write `page` to the URL. A reload starts at page 1 of the current `q`.

A click on Load more while the next page is already in flight does not send another request.

## Failure

When page 1 of the current Search fails, show an element with role `alert` and the text `Could not load venues`. Do not keep the previous Search venues.

When a Load more request fails, keep the venues already on the page, keep Load more, and show an element with role `alert` and the text `Could not load more`.

The Search box, Open now, and Sort stay on the page while list requests are in flight.
