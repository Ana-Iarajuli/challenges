# Mikiri Medal Desk

Staff tool for the [challenges.mikiri.ge](https://challenges.mikiri.ge/) leaderboards: tick off who has collected their medal from the shop and flag suspected cheaters.

## How it works

- The browser reads challenges and leaderboards straight from the public Mikiri API (`https://challenges-api.mikiri.ge/api`), so the data is always live.
- Checkbox state and medal stock are saved by a Netlify Function (`netlify/functions/state.mjs`, served at `/api/state`) in Netlify Blobs, so every staff member sees the same thing. Open pages refresh every 20 seconds.
- Everything is behind one shared staff password (the `ADMIN_PASSWORD` environment variable).

| Feature | Notes |
| --- | --- |
| Medals in stock | Set per challenge. "Remaining" = stock − medals given out. |
| Medal taken | One checkbox per individual (Individual challenges) or per team (Team challenges). A team counts as one medal per member. |
| Cheating? | Flag checkbox on every individual, team and team member. A flagged member also flags the team row. |
| Filters | All · Finished (reached the goal) · Waiting for medal (finished, not flagged, not collected) · Medal taken · Flagged |
| Export CSV | Full list for the selected challenge, including when each box was ticked. |


