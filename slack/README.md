# Slack Gist Helper

The web dashboard is the first slice. Slack comes next as a Cursor BDK agent
that calls the same `/api/performance` join (Meta ad id ↔ Adjust
`creative_id_network`, D1/D3/D7).

## Planned setup

```bash
npx --yes "@cursor/bdk@0.2.25" init
npx --yes "@cursor/bdk@0.2.25" slack create --dir . --name "Gist Helper"
```

Suggested prompts:

- What are our top creatives by $/D7 this window?
- D3 retention for campaign X
- Summarize Janelle creatives

Secrets (environment only, never chat): `META_ACCESS_TOKEN`, `ADJUST_API_TOKEN`,
plus the Slack bot/app tokens the BDK wizard writes.

Until Slack is wired, hit the dashboard or:

```bash
curl -s "http://127.0.0.1:43127/api/performance?top=10" | jq .
```
