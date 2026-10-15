# Gist Creative Intelligence

Read-only creative performance for Gist UA:

- Native creative thumbnails (Meta)
- Meta spend + install proxy (LEAD)
- Adjust installs and **D1 / D3 / D7** retention
- Join on **Meta `ad_id` = Adjust `creative_id_network`**
- Group/filter by value prop, message, hook, visual treatment, format, creator, campaign
- Parsed tags from the Gist naming convention, with human corrections saved under `data/tag-overrides.json`

TikTok / AppLovin come later. This product does **not** change budgets, statuses, or ads.

Sister workstream for partnership Post ID launches lives on
`cathy-sun-applovin/gist-ua` branch `cursor/partnership-post-id-4949`.

## Quick start

```bash
cp .env.example .env.local
# fill META_ACCESS_TOKEN and ADJUST_API_TOKEN (from Cathy / gist-ua .env)
npm install
npm run dev
```

Open [http://127.0.0.1:43127](http://127.0.0.1:43127). Without tokens the API
serves labeled **mock** data so the UI is usable.

```bash
npm test
npm run build
```

## Android Performance Summary (Cathy ask)

Writes **one new tab** on the existing tracking sheet — does not touch Cloud Run
or other tabs.

Needs the same `.env.local` tokens plus Google ADC (`gcloud auth application-default login`).

```bash
npm install
npm run android-summary
```

Then open the [tracking sheet](https://docs.google.com/spreadsheets/d/1KgagbkqKRQHVqK-P1yURh-GixzpG_mTgp6jW2QZMhsw/edit) → **Android Performance Summary**.

## Data window

Default window matches Cathy’s `top_ads_retention.py`: **14 days ending 8 days
ago**, so D7 cohorts are mature.

## Slack

See [`slack/README.md`](slack/README.md). Dashboard + API first; BDK Slack bot next.

## Secrets

| Key | Needed for |
|---|---|
| `META_ACCESS_TOKEN` | Spend, insights, thumbnails |
| `ADJUST_API_TOKEN` | Installs + retained_users_d1/d3/d7 |
| `META_USER_TOKEN` | **Not** needed (read-only) |
| Google ADC | Android sheet writer + future Drive originals |
