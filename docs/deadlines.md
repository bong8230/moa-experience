# Deadline verification

A collected `days_left` value is a date inferred from a remaining-days label. It must not become a confirmed deadline merely by removing the estimated label.

The first supported original source is Dinnerqueen. Its public detail page distinguishes the application period, announcement and review period. Verification uses the application period's explicit year/month/day and cross-checks the application calendar event. Calendar end values are exclusive; announcement countdowns are not application deadlines. No closing time is invented when the source publishes only a date.

Verified dates are cached and applied before deadline filtering and ordering. Original requests must be bounded, shared across users, cached and limited to approved source URLs. Failed, conflicting or unsupported evidence retains its unverified status.

Reviewnote detail access is restricted by its robots policy. Gangnam's sampled date labels omit a year. Neither limitation justifies claiming a fully verified date. Further source integrations need their own evidence and validation.

Dinnerqueen checks share database caches, a daily cap and pacing across instances. Verified dates are also used by saved and excluded lists, including older saved snapshots. The first response may retain an estimate while verification finishes; later requests use the verified result. Only successful evidence is shown as `원본 확인`. Verification does not invent a closing hour.
