"use client";

import { useEffect, useMemo, useState } from "react";
import type { CreativeRow, PerformancePayload } from "@/lib/types";

function money(n: number | null | undefined) {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function pct(n: number | null | undefined) {
  if (n == null || Number.isNaN(n)) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

export function Dashboard() {
  const [data, setData] = useState<PerformancePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [tagFilter, setTagFilter] = useState("all");
  const [selected, setSelected] = useState<CreativeRow | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/performance?top=50");
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || "Failed to load");
        if (!cancelled) setData(json);
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const valueProps = useMemo(() => {
    const s = new Set<string>();
    for (const c of data?.creatives || []) {
      if (c.tags.valueProp) s.add(c.tags.valueProp);
    }
    return ["all", ...[...s].sort()];
  }, [data]);

  const rows = useMemo(() => {
    let list = data?.creatives || [];
    if (tagFilter !== "all") {
      list = list.filter((c) => c.tags.valueProp === tagFilter);
    }
    if (q.trim()) {
      const needle = q.trim().toLowerCase();
      list = list.filter(
        (c) =>
          c.adName.toLowerCase().includes(needle) ||
          c.tags.hook?.toLowerCase().includes(needle) ||
          c.tags.creator?.toLowerCase().includes(needle) ||
          c.campaigns.some((x) => x.toLowerCase().includes(needle)),
      );
    }
    return list;
  }, [data, q, tagFilter]);

  async function saveTags(row: CreativeRow, patch: Record<string, string>) {
    setSaving(true);
    try {
      const res = await fetch("/api/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: row.adId, tags: patch }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          creatives: prev.creatives.map((c) =>
            c.adId === row.adId
              ? { ...c, tags: { ...c.tags, ...json.tags }, tagSource: "human" }
              : c,
          ),
        };
      });
      setSelected((s) =>
        s && s.adId === row.adId
          ? { ...s, tags: { ...s.tags, ...json.tags }, tagSource: "human" }
          : s,
      );
    } catch (e) {
      alert(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="mx-auto min-h-screen max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-8 grid gap-4 lg:grid-cols-[1.2fr_0.8fr] lg:items-end">
        <div>
          <p
            className="text-sm font-semibold tracking-[0.18em] uppercase"
            style={{ color: "var(--accent)" }}
          >
            Gist Creative Intelligence
          </p>
          <h1
            className="mt-2 max-w-2xl text-4xl leading-tight sm:text-5xl"
            style={{ fontFamily: "var(--font-fraunces), Georgia, serif" }}
          >
            Which creatives earn retention, not just installs
          </h1>
          <p className="mt-3 max-w-xl text-base" style={{ color: "var(--muted)" }}>
            Meta spend joined to Adjust installs and D1/D3/D7 on{" "}
            <code className="rounded bg-white/70 px-1">creative_id_network</code>
            . Read-only.
          </p>
        </div>
        <div
          className="rounded-2xl border px-4 py-3 text-sm"
          style={{
            borderColor: "var(--line)",
            background: "var(--card)",
            boxShadow: "var(--shadow)",
          }}
        >
          {loading && <p>Loading performance…</p>}
          {error && (
            <p style={{ color: "#8b1e1e" }}>
              Error: {error}. Showing nothing until the API recovers.
            </p>
          )}
          {data && !loading && (
            <>
              <p>
                <strong>{data.source === "live" ? "Live" : "Mock"}</strong> ·{" "}
                {data.since} → {data.until}
              </p>
              <p className="mt-1" style={{ color: "var(--muted)" }}>
                Account {money(data.account.spend)} · Adjust FB installs{" "}
                {data.account.installs.toFixed(0)} · D7{" "}
                {pct(
                  data.account.installs
                    ? data.account.d7 / data.account.installs
                    : null,
                )}{" "}
                · unmatched {data.account.unmatchedInstalls.toFixed(0)}
              </p>
              {data.note && (
                <p className="mt-2" style={{ color: "var(--warn)" }}>
                  {data.note}
                </p>
              )}
            </>
          )}
        </div>
      </header>

      <section className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter by name, hook, creator, campaign"
          className="w-full rounded-xl border bg-white/80 px-3 py-2 text-sm outline-none sm:max-w-md"
          style={{ borderColor: "var(--line)" }}
        />
        <select
          value={tagFilter}
          onChange={(e) => setTagFilter(e.target.value)}
          className="rounded-xl border bg-white/80 px-3 py-2 text-sm"
          style={{ borderColor: "var(--line)" }}
        >
          {valueProps.map((v) => (
            <option key={v} value={v}>
              {v === "all" ? "All value props" : v}
            </option>
          ))}
        </select>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.4fr_0.8fr]">
        <div className="overflow-hidden rounded-2xl border bg-white/70" style={{ borderColor: "var(--line)", boxShadow: "var(--shadow)" }}>
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b text-xs tracking-wide uppercase" style={{ borderColor: "var(--line)", color: "var(--muted)" }}>
                <tr>
                  <th className="px-3 py-3">Creative</th>
                  <th className="px-3 py-3">Spend</th>
                  <th className="px-3 py-3">Adj installs</th>
                  <th className="px-3 py-3">D3</th>
                  <th className="px-3 py-3">D7</th>
                  <th className="px-3 py-3">$/D7</th>
                </tr>
              </thead>
              <tbody>
                {!loading && rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center" style={{ color: "var(--muted)" }}>
                      No creatives match this filter.
                    </td>
                  </tr>
                )}
                {rows.map((row) => (
                  <tr
                    key={row.adId}
                    onClick={() => setSelected(row)}
                    className="cursor-pointer border-t transition hover:bg-[var(--accent-soft)]"
                    style={{ borderColor: "var(--line)" }}
                  >
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-3">
                        <div
                          className="h-14 w-11 shrink-0 overflow-hidden rounded-lg bg-[#dfe8e2]"
                          style={{
                            backgroundImage: row.thumbnailUrl
                              ? `url(${row.thumbnailUrl})`
                              : undefined,
                            backgroundSize: "cover",
                            backgroundPosition: "center",
                          }}
                        />
                        <div>
                          <div className="font-medium">{row.adName}</div>
                          <div className="text-xs" style={{ color: "var(--muted)" }}>
                            {row.tags.creator || "—"} · {row.tags.valueProp || "untagged"} ·{" "}
                            {row.tagSource}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">{money(row.spend)}</td>
                    <td className="px-3 py-3">{row.installs.toFixed(0)}</td>
                    <td className="px-3 py-3">{pct(row.d3Rate)}</td>
                    <td className="px-3 py-3">{pct(row.d7Rate)}</td>
                    <td className="px-3 py-3 whitespace-nowrap">{money(row.costPerD7)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <aside
          className="rounded-2xl border p-4"
          style={{
            borderColor: "var(--line)",
            background: "var(--card)",
            boxShadow: "var(--shadow)",
          }}
        >
          {!selected && (
            <p style={{ color: "var(--muted)" }}>
              Select a creative to preview tags and correct AI/parsed labels.
            </p>
          )}
          {selected && (
            <div className="space-y-3">
              <div
                className="aspect-[4/5] w-full overflow-hidden rounded-xl bg-[#dfe8e2]"
                style={{
                  backgroundImage: selected.thumbnailUrl
                    ? `url(${selected.thumbnailUrl})`
                    : undefined,
                  backgroundSize: "cover",
                  backgroundPosition: "center",
                }}
              />
              <h2
                className="text-xl leading-snug"
                style={{ fontFamily: "var(--font-fraunces), Georgia, serif" }}
              >
                {selected.adName}
              </h2>
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                {selected.campaigns.join(" · ")}
              </p>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <dt style={{ color: "var(--muted)" }}>Spend</dt>
                  <dd className="font-medium">{money(selected.spend)}</dd>
                </div>
                <div>
                  <dt style={{ color: "var(--muted)" }}>Meta installs</dt>
                  <dd className="font-medium">{selected.metaInstalls.toFixed(0)}</dd>
                </div>
                <div>
                  <dt style={{ color: "var(--muted)" }}>D1 / D3 / D7</dt>
                  <dd className="font-medium">
                    {pct(selected.d1Rate)} / {pct(selected.d3Rate)} /{" "}
                    {pct(selected.d7Rate)}
                  </dd>
                </div>
                <div>
                  <dt style={{ color: "var(--muted)" }}>$/D3 · $/D7</dt>
                  <dd className="font-medium">
                    {money(selected.costPerD3)} · {money(selected.costPerD7)}
                  </dd>
                </div>
              </dl>
              <form
                className="space-y-2 border-t pt-3"
                style={{ borderColor: "var(--line)" }}
                onSubmit={(e) => {
                  e.preventDefault();
                  const fd = new FormData(e.currentTarget);
                  void saveTags(selected, {
                    valueProp: String(fd.get("valueProp") || ""),
                    message: String(fd.get("message") || ""),
                    hook: String(fd.get("hook") || ""),
                    visualTreatment: String(fd.get("visualTreatment") || ""),
                    creator: String(fd.get("creator") || ""),
                    format: String(fd.get("format") || "unknown"),
                  });
                }}
              >
                <p className="text-xs tracking-wide uppercase" style={{ color: "var(--muted)" }}>
                  Human tag corrections
                </p>
                {(
                  [
                    ["valueProp", "Value prop"],
                    ["message", "Message"],
                    ["hook", "Hook"],
                    ["visualTreatment", "Visual treatment"],
                    ["creator", "Creator"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className="block text-sm">
                    <span style={{ color: "var(--muted)" }}>{label}</span>
                    <input
                      name={key}
                      defaultValue={(selected.tags as Record<string, string | undefined>)[key] || ""}
                      className="mt-1 w-full rounded-lg border bg-white px-2 py-1.5"
                      style={{ borderColor: "var(--line)" }}
                    />
                  </label>
                ))}
                <label className="block text-sm">
                  <span style={{ color: "var(--muted)" }}>Format</span>
                  <select
                    name="format"
                    defaultValue={selected.tags.format || "unknown"}
                    className="mt-1 w-full rounded-lg border bg-white px-2 py-1.5"
                    style={{ borderColor: "var(--line)" }}
                  >
                    <option value="unknown">unknown</option>
                    <option value="video">video</option>
                    <option value="static">static</option>
                    <option value="carousel">carousel</option>
                  </select>
                </label>
                <button
                  type="submit"
                  disabled={saving}
                  className="mt-2 w-full rounded-xl px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
                  style={{ background: "var(--accent)" }}
                >
                  {saving ? "Saving…" : "Save corrections"}
                </button>
              </form>
            </div>
          )}
        </aside>
      </section>
    </main>
  );
}
