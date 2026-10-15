/**
 * Cathy ask: Android-only Ads Performance Summary on the existing tracking sheet.
 *
 * Safe / additive:
 *   - Creates tab "Android Performance Summary" if missing
 *   - Overwrites THAT tab only
 *   - Does not change CPI Report, Unique Creatives, Cloud Run, etc.
 *
 * Run from repo root (ADC + .env.local already set up):
 *
 *   npm install
 *   npm run android-summary
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { google } from "googleapis";

const SHEET_ID = "1KgagbkqKRQHVqK-P1yURh-GixzpG_mTgp6jW2QZMhsw";
const TAB = "Android Performance Summary";
const START_DATE = "2026-10-01";
const META_ACCT = process.env.META_AD_ACCOUNT_ID || "act_990337856783605";
const META_API = "https://graph.facebook.com/v26.0";
const ADJUST_URL = "https://automate.adjust.com/reports-service/report";
const ACCT_EVENT = "post_install_account_created";

function loadEnvLocal() {
  for (const name of [".env.local", ".env"]) {
    const p = resolve(process.cwd(), name);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2].trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] == null || process.env[key] === "") {
        process.env[key] = val;
      }
    }
  }
}

function iso(d: Date) {
  return d.toISOString().slice(0, 10);
}

function normPartner(p: string) {
  const lp = (p || "").toLowerCase();
  if (lp.includes("tiktok") || lp.includes("bytedance")) return "TikTok";
  if (lp.includes("reddit")) return "Reddit";
  if (lp.includes("facebook") || lp.includes("meta")) return "Facebook";
  if (lp.includes("applovin")) return "Applovin";
  return p;
}

function isAndroidCampaign(name: string | undefined) {
  return (name || "").toLowerCase().includes("android");
}

function isAndroidOs(os: string | undefined) {
  return (os || "").trim().toLowerCase() === "android";
}

function cost(spend: number, n: number) {
  return n > 0 ? Math.round((spend / n) * 100) / 100 : "";
}

function pct(n: number, d: number) {
  return d > 0 ? Math.round((n / d) * 10000) / 10000 : "";
}

async function adjustReport(
  token: string,
  datePeriod: string,
  metric: string,
) {
  const url = new URL(ADJUST_URL);
  url.searchParams.set("date_period", datePeriod);
  url.searchParams.set("dimensions", "day,partner_name,os_name");
  url.searchParams.set("metrics", metric);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Adjust ${metric} HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }
  const json = (await res.json()) as { rows?: Array<Record<string, string | number>> };
  return json.rows || [];
}

async function androidByPartner(
  token: string,
  datePeriod: string,
  metric: string,
) {
  const out = new Map<string, Map<string, number>>();
  for (const row of await adjustReport(token, datePeriod, metric)) {
    if (!isAndroidOs(String(row.os_name || ""))) continue;
    const day = String(row.day || "");
    if (!day) continue;
    const partner = normPartner(String(row.partner_name || ""));
    if (!out.has(day)) out.set(day, new Map());
    const m = out.get(day)!;
    m.set(partner, (m.get(partner) || 0) + Number(row[metric] || 0));
  }
  return out;
}

async function metaAndroidSpend(token: string, start: string, end: string) {
  const tzRes = await fetch(
    `${META_API}/${META_ACCT}?fields=timezone_name&access_token=${token}`,
  );
  const tzJson = (await tzRes.json()) as { timezone_name?: string };
  const tzName = tzJson.timezone_name || "America/Los_Angeles";

  const out = new Map<string, number>();
  let cursor = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  cursor.setUTCDate(cursor.getUTCDate() - 1);

  while (cursor <= endDate) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + 6);
    if (chunkEnd > endDate) chunkEnd.setTime(endDate.getTime());

    let url: string | null = `${META_API}/${META_ACCT}/insights`;
    let params: URLSearchParams | null = new URLSearchParams({
      access_token: token,
      level: "campaign",
      fields: "campaign_name,spend",
      breakdowns: "hourly_stats_aggregated_by_advertiser_time_zone",
      time_increment: "1",
      time_range: JSON.stringify({
        since: iso(cursor),
        until: iso(chunkEnd),
      }),
      limit: "500",
      filtering: JSON.stringify([
        { field: "campaign.name", operator: "CONTAIN", value: "Android" },
      ]),
    });

    let useFilter = true;
    while (url) {
      const full = params ? `${url}?${params}` : url;
      const res = await fetch(full);
      const d = (await res.json()) as {
        error?: unknown;
        data?: Array<Record<string, string>>;
        paging?: { next?: string };
      };
      if (d.error && useFilter && params?.has("filtering")) {
        console.warn("Meta name filter rejected; filtering client-side");
        useFilter = false;
        params.delete("filtering");
        continue;
      }
      if (d.error) {
        throw new Error(`Meta insights error: ${JSON.stringify(d.error).slice(0, 400)}`);
      }
      for (const x of d.data || []) {
        if (!isAndroidCampaign(x.campaign_name)) continue;
        const hr = Number(String(x.hourly_stats_aggregated_by_advertiser_time_zone).slice(0, 2));
        const [y, m, dd] = x.date_start.split("-").map(Number);
        // Approximate UTC day from account-TZ hour (same idea as gist-ua).
        const local = new Date(Date.UTC(y, m - 1, dd, hr));
        // Shift roughly for PT if needed — prefer Intl for tz offset.
        const asLocal = new Date(
          local.toLocaleString("en-US", { timeZone: tzName }),
        );
        // Better: construct with temporal offset via formatToParts
        const utcDay = iso(
          new Date(
            new Date(`${x.date_start}T${String(hr).padStart(2, "0")}:00:00`).toLocaleString(
              "en-US",
              { timeZone: "UTC" },
            ),
          ),
        );
        // Use a clearer conversion:
        const instant = Date.parse(
          // interpret date_start+hour in account TZ
          new Date(`${x.date_start}T${String(hr).padStart(2, "0")}:00:00`).toISOString().replace("Z", ""),
        );
        void asLocal;
        void instant;
        // Final approach: format the account-local datetime as UTC day via Intl
        const parts = new Intl.DateTimeFormat("en-CA", {
          timeZone: tzName,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          hourCycle: "h23",
        }).formatToParts(new Date(`${x.date_start}T12:00:00Z`));
        // Simpler reliable method used below
        const fakeUtc = new Date(`${x.date_start}T${String(hr).padStart(2, "0")}:30:00Z`);
        // Convert "wall time in tzName" to UTC:
        const wall = `${x.date_start}T${String(hr).padStart(2, "0")}:00:00`;
        const utcDayFinal = wallTimeToUtcDay(wall, tzName);
        void parts;
        void utcDay;
        void fakeUtc;
        out.set(utcDayFinal, (out.get(utcDayFinal) || 0) + Number(x.spend || 0));
      }
      url = d.paging?.next || null;
      params = null;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return out;
}

/** Interpret YYYY-MM-DDTHH:00:00 as wall time in `timeZone`, return UTC YYYY-MM-DD. */
function wallTimeToUtcDay(wall: string, timeZone: string) {
  // Binary-search UTC instant that formats to the wall time in the zone.
  const [datePart, timePart] = wall.split("T");
  const [Y, M, D] = datePart.split("-").map(Number);
  const [h] = timePart.split(":").map(Number);
  let lo = Date.UTC(Y, M - 1, D - 1, 0, 0, 0);
  let hi = Date.UTC(Y, M - 1, D + 1, 23, 59, 59);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    hourCycle: "h23",
  });
  for (let i = 0; i < 40; i++) {
    const mid = Math.floor((lo + hi) / 2);
    const parts = Object.fromEntries(
      fmt.formatToParts(new Date(mid)).map((p) => [p.type, p.value]),
    );
    const py = Number(parts.year);
    const pm = Number(parts.month);
    const pd = Number(parts.day);
    const ph = Number(parts.hour === "24" ? "0" : parts.hour);
    const key = ((py * 100 + pm) * 100 + pd) * 100 + ph;
    const target = ((Y * 100 + M) * 100 + D) * 100 + h;
    if (key === target) return new Date(mid).toISOString().slice(0, 10);
    if (key < target) lo = mid + 1;
    else hi = mid - 1;
  }
  // Fallback: date_start as UTC day
  return datePart;
}

async function sheetsClient() {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

async function ensureTab(sheets: ReturnType<typeof google.sheets> extends infer T ? any : never) {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
    fields: "sheets.properties",
  });
  for (const s of meta.data.sheets || []) {
    if (s.properties?.title === TAB) return s.properties.sheetId as number;
  }
  const resp = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [{ addSheet: { properties: { title: TAB } } }],
    },
  });
  return resp.data.replies?.[0]?.addSheet?.properties?.sheetId as number;
}

async function main() {
  loadEnvLocal();
  const adjustToken = process.env.ADJUST_API_TOKEN?.trim();
  const metaToken = process.env.META_ACCESS_TOKEN?.trim();
  if (!adjustToken || !metaToken) {
    throw new Error(
      "Missing ADJUST_API_TOKEN or META_ACCESS_TOKEN in .env.local",
    );
  }

  const start = START_DATE;
  const today = iso(new Date());
  const datePeriod = `${start}:${today}`;
  console.log(`Android summary ${datePeriod} → sheet tab "${TAB}"`);

  const [installs, signups, d1, metaSpend] = await Promise.all([
    androidByPartner(adjustToken, datePeriod, "installs"),
    androidByPartner(adjustToken, datePeriod, `${ACCT_EVENT}_events`),
    androidByPartner(adjustToken, datePeriod, "retained_users_d1"),
    metaAndroidSpend(metaToken, start, today),
  ]);

  const days = [
    ...new Set([...installs.keys(), ...signups.keys(), ...metaSpend.keys()]),
  ]
    .filter((d) => d >= start && d <= today)
    .sort()
    .reverse();

  const banner =
    `ANDROID ONLY. Adjust=os_name android. Meta spend=campaigns with 'Android' in name. Updated ${new Date().toISOString()}.`;

  const headers = [
    "UTC Day",
    "Meta Spend",
    "Meta Installs",
    "AppLovin Installs",
    "Organic Installs",
    "Total Installs",
    "Meta Sign Ups",
    "AppLovin Sign Ups",
    "Organic Sign Ups",
    "Total Sign Ups",
    "Meta CPI",
    "Meta CPS",
    "Meta D1",
    "Total D1",
  ];

  const grid: Array<Array<string | number>> = [[banner], headers];
  for (const day of days) {
    const mSpend = metaSpend.get(day) || 0;
    const inst = installs.get(day) || new Map();
    const su = signups.get(day) || new Map();
    const ret = d1.get(day) || new Map();
    const mInst = inst.get("Facebook") || 0;
    const aInst = inst.get("Applovin") || 0;
    const oInst = inst.get("Organic") || 0;
    const totInst = [...inst.values()].reduce((a, b) => a + b, 0);
    const mSu = su.get("Facebook") || 0;
    const aSu = su.get("Applovin") || 0;
    const oSu = su.get("Organic") || 0;
    const totSu = [...su.values()].reduce((a, b) => a + b, 0);
    const mD1 = ret.get("Facebook") || 0;
    const totD1 = [...ret.values()].reduce((a, b) => a + b, 0);
    const d1Ready = day < today;

    grid.push([
      day,
      Math.round(mSpend * 100) / 100,
      Math.round(mInst),
      Math.round(aInst),
      Math.round(oInst),
      Math.round(totInst),
      Math.round(mSu),
      Math.round(aSu),
      Math.round(oSu),
      Math.round(totSu),
      cost(mSpend, mInst),
      cost(mSpend, mSu),
      d1Ready ? pct(mD1, mInst) : "",
      d1Ready ? pct(totD1, totInst) : "",
    ]);
  }

  const sheets = await sheetsClient();
  const gid = await ensureTab(sheets);
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: `'${TAB}'!A:Z`,
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `'${TAB}'!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: grid },
  });

  const nrows = grid.length;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [
        {
          updateSheetProperties: {
            properties: {
              sheetId: gid,
              gridProperties: { frozenRowCount: 2, columnCount: headers.length },
            },
            fields: "gridProperties.frozenRowCount,gridProperties.columnCount",
          },
        },
        {
          repeatCell: {
            range: { sheetId: gid, startRowIndex: 0, endRowIndex: 2 },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: "userEnteredFormat.textFormat.bold",
          },
        },
        {
          repeatCell: {
            range: {
              sheetId: gid,
              startRowIndex: 2,
              endRowIndex: nrows,
              startColumnIndex: 1,
              endColumnIndex: 2,
            },
            cell: {
              userEnteredFormat: {
                numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" },
              },
            },
            fields: "userEnteredFormat.numberFormat",
          },
        },
        {
          repeatCell: {
            range: {
              sheetId: gid,
              startRowIndex: 2,
              endRowIndex: nrows,
              startColumnIndex: 10,
              endColumnIndex: 12,
            },
            cell: {
              userEnteredFormat: {
                numberFormat: { type: "CURRENCY", pattern: "$#,##0.00" },
              },
            },
            fields: "userEnteredFormat.numberFormat",
          },
        },
        {
          repeatCell: {
            range: {
              sheetId: gid,
              startRowIndex: 2,
              endRowIndex: nrows,
              startColumnIndex: 12,
              endColumnIndex: 14,
            },
            cell: {
              userEnteredFormat: {
                numberFormat: { type: "PERCENT", pattern: "0.0%" },
              },
            },
            fields: "userEnteredFormat.numberFormat",
          },
        },
      ],
    },
  });

  console.log(
    `Done. Tab "${TAB}" updated (${days.length} days). Other tabs untouched.`,
  );
  console.log(
    `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=${gid}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
