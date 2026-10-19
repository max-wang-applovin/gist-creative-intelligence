# Creative Intelligence

Read-only Meta Ads + Adjust creative intelligence dashboard with live creative previews, retention reporting, delivery slices, and AI analysis.

## Render deployment

The `main` branch is configured for an always-on Render Node service with a 1 GB persistent disk.

1. Create a Render Blueprint from this repository and select `main`, or configure a Web Service from `render.yaml`.
2. Enter every variable marked `sync: false` when Render prompts. Never commit API keys to GitHub.
3. Choose a unique `DASHBOARD_USERNAME` and a `DASHBOARD_PASSWORD` of at least 12 characters.
4. Deploy and open `/healthz` to confirm the service is healthy.

Render injects `PORT`; the server listens on it automatically. Persistent analysis and schedule state is written to `/var/data`. Production startup fails closed when dashboard credentials are missing.

For a manually configured Render Web Service use:

```text
Branch: main
Build Command: npm install && npm run check
Start Command: npm start
Health Check Path: /healthz
```

Use the `0.5c-512mb` paid compute plan and mount a 1 GB disk at `/var/data`.

## Local dashboard

```bash
npm install
cp .env.example .env.local
npm run dashboard
# http://127.0.0.1:4173
```

## Hosting environment

| Variable | Purpose |
| --- | --- |
| `META_ACCESS_TOKEN` | Meta Marketing API user/system token |
| `META_AD_ACCOUNT_ID` | Ad account id (`act_…` or bare digits) |
| `ADJUST_API_TOKEN` | Adjust Report Service bearer token |
| `ADJUST_APP_NAME` | Optional app-name filter |
| `OPENAI_API_KEY` | Enables vision-based creative scans |
| `OPENAI_ANALYSIS_MODEL` | Scan model, default `gpt-4.1-mini` |
| `ADMANAGE_API_KEY` | Read-only AdScan feed and direct video fallback |
| `DASHBOARD_USERNAME` | Shared dashboard login; required in production |
| `DASHBOARD_PASSWORD` | Shared password, minimum 12 characters; required in production |
| `DASHBOARD_DATA_DIR` | Persistent state directory; `/var/data` on Render |
| `CREATIVE_SCAN_DAILY_LIMIT` | Daily cap, default 500 and max 10,000 |
| `CREATIVE_SCAN_FORCE_DAILY` | Set `false` to skip unchanged creatives |

Automatic scans default to 500 creatives and skip unchanged fingerprints to control OpenAI usage.

## Verify

```bash
npm run check
npm start
```
