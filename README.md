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

## Deploy on Netlify

1. Push this folder to a GitHub/GitLab repo.
2. In Netlify: **Add new site → Import an existing project** and pick the repo. The settings come from `netlify.toml`, so leave the build command empty.
3. **Site configuration → Environment variables**: add `ADMIN_PASSWORD` with the staff password.
4. Deploy (or redeploy after adding the variable).

Drag-and-drop deploys won't work, because they don't bundle functions. Use a Git import or `netlify deploy --prod` from the Netlify CLI.

## Local development

```sh
npm install
ADMIN_PASSWORD=test npx netlify dev
```
