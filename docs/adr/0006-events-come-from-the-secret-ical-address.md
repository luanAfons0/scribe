# Events come from the calendar's secret iCal address

scribe gives a Notice a minute before an Event, so it must read the
operator's Google Calendar. It reads the calendar's "secret address in iCal
format", which the operator pastes into Settings, and nothing else. scribe
holds no OAuth client and no token, as it holds no key for a model
(ADR-0002).

Only an Event with a Google Meet link counts: scribe records a call in a
browser tab (ADR-0001), and an Event with no link, or one held in another
app, has nothing to record.

## Considered Options

The Google Calendar API, through OAuth. Rejected: it needs a Google Cloud
project, a consent screen, and a refresh token kept in the Plugin directory,
for a list of what starts next.

## Consequences

The secret address is a secret: whoever holds it reads the whole calendar.
scribe keeps it in `settings.json`, never prints it, and the Page never shows
it back once saved.

A Google Workspace admin can turn the secret address off. Then there is no
Event, and scribe records as it did before.

scribe reads the iCal text with its own small reader, recurring rules
included, as far as Google writes them. It takes no dependency.
