# Saved filters

Authenticated filter preferences belong to the Kakao account and persist in the database across logout, sessions and devices. Nicknames, favorites, marks and administrator authorization remain independent.

The filter panel edits a draft. Confirm saves and applies the draft, reloads results and closes the panel. Closing without confirming preserves the applied filters. Resetting and confirming saves an empty selection, so old preferences must not reappear at the next login.

Saved conditions include categories, campaign sites, review channels, regions, search text, nearby base location, radius, delivery inclusion and sort order. Coordinates are rounded to three decimal places. Restoring a saved location does not request GPS permission or update the location automatically.

Guest preferences remain in a separate browser storage namespace. Logging out or switching accounts must not expose one account's preferences to another. Server preference retrieval failure must not overwrite existing saved conditions with defaults.
