# Creative Intelligence

Bot Development Kit (BDK) project (`@cursor/bdk`). This file is for coding agents editing the project. The served agent's prompt is `bot/instructions.md`.

## Loop

```bash
npx @cursor/bdk validate --dir .
npx @cursor/bdk info --dir . --json
npx @cursor/bdk run --dir . --message "..."
npx @cursor/bdk eval --dir .
npm run check
```

Run the CLI under Node, never Bun.

## Layout

- `bot/instructions.md` is the always-on prompt.
- `bot/tools/<name>.ts` is one tool per file.
- `bot/lib/` holds Meta/Adjust clients, fixtures, and the dashboard join.
- `dashboard/` is the AdManage-style visual library (`npm run dashboard`).
- `evals/` is filesystem evals.

## Safety

- Keep Meta and Adjust operations read-only.
- Never commit API credentials.
- Production dashboard deployments must require authentication.
