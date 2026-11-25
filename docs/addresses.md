# Business addresses

Show a business address only when the campaign's own visit/location section provides it, or when the existing Kakao place matcher returns an eligible place. Platform-company footers, hidden comments, shipping seller addresses and district centroids are not venue addresses.

Original campaign addresses take precedence. Kakao-matched addresses must be labelled as search matches rather than original-source verification. Missing or ambiguous addresses remain absent.

Original detail requests are bounded and cached. Dinnerqueen deadline and address extraction should share a page fetch. Gangnam Review needs its own permitted detail-page adapter. Do not crawl restricted Reviewnote detail paths or bypass access controls.

Kakao address fields reuse existing place results. Loading cached fields does not call Kakao. An older coordinate hit may receive one conservative address backfill per nearby request; the original place identity and coordinate expiry are preserved. Failed backfills receive a shared retry delay.

Maps links must use allowed HTTPS hosts. Address strings are rendered as text, including in saved and excluded lists. An address by itself does not turn an approximate distance into a precise distance.

## Initial coverage

Original adapters cover Dinnerqueen and Gangnam Review visiting campaigns. Only a few visible campaigns are checked per list request; results arrive on a later request when background checks run. Unsupported or unverified addresses stay blank. Previously cached Kakao place matches can supply an explicitly labelled fallback without a new search.

Deployment smoke found Dinnerqueen addresses working on Vercel. Gangnam Review returned HTTP 403 for its robots policy from Vercel; the collector fails closed and leaves those addresses absent. Local parser support does not establish cloud collection availability.
