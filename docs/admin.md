# Owner dashboard

The site owner keeps all normal campaign, favorite and application features. An additional administrator link opens `/admin`.

Authorization uses the authenticated Kakao account ID against the server-side `ADMIN_KAKAO_IDS` allowlist. Nicknames and client-supplied roles never grant privileges. Both the HTML route and dashboard API require authorization; hiding a menu is not an access control.

Production is configured for the sole account already present when the owner requested this feature. Future signups receive no administrator privileges. The account identifier is configured outside Git.

The dashboard reports logged-in users' visits and campaign source-link clicks. A campaign view means opening its original listing; rendering a search result does not count. Collection starts with this release, so older activity cannot be reconstructed.

Do not collect IP addresses, precise locations, authentication tokens or session identifiers in analytics. User nicknames are display names; duplicate names are allowed.
