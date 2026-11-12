const state = {
  payload: null,
  slices: { publisher: null, demographic: null, device: null, os: null },
  sliceLoading: new Set(),
  activeSlice: null,
  initialSliceApplied: false,
  initialDetailApplied: false,
  loading: false,
  mediaRequest: 0,
  selected: null,
  compareIds: new Set(),
  detail: null,
  page: "library",
  analysis: null,
  videoMetrics: null,
  competitors: null,
  debrief: null,
  debriefLoading: false,
  debriefPollTimer: null,
  debriefDetail: null,
  debriefHoverTimer: null,
  debriefHoverButton: null,
  debriefPreviewCache: new Map(),
  debriefSection: "decisions",
  debriefPageNumber: 1,
  debriefTestedPageNumber: 1,
  expandedTestedGroups: new Set(),
  scanJob: null,
  analysisReport: "overview",
  experiments: [],
  savedReports: [],
  testBriefs: [],
};

const $ = (id) => document.getElementById(id);
const grid = $("creativeGrid");
const loading = $("loading");
const warning = $("warning");
const dialog = $("detailDialog");

const money = (value, compact = false) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: compact ? 0 : 2,
    notation: compact ? "compact" : "standard",
  }).format(Number(value || 0));
const integer = (value) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(
    Number(value || 0),
  );
const compact = (value) =>
  new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(Number(value || 0));
const pct = (value) => `${Number(value || 0).toFixed(1)}%`;
const retentionPct = (value, denominator) =>
  Number(denominator || 0) > 0 ? pct(value) : "—";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function primaryMetric(row) {
  const overall = state.activeSlice ? " · all aud." : "";
  switch ($("sortMetric").value) {
    case "installs":
      return [`Installs${overall}`, integer(row.adjustInstalls)];
    case "cpi":
      return [`CPI${overall}`, money(row.cpi)];
    case "cvr":
      return [`CVR${overall}`, pct(row.cvr)];
    case "ctr":
      return ["CTR", pct(row.metaCtr)];
    case "d7":
      return [
        `D7${overall}`,
        retentionPct(row.adjustRetentionD7, row.adjustRetentionDenD7),
      ];
    default:
      return ["Amount spent", money(row.metaSpend, true)];
  }
}

function mediaTypeFor(row) {
  if (row.media.some((item) => item.mediaType === "video")) return "video";
  if (row.media.some((item) => item.mediaType === "image")) return "image";
  return "missing";
}

function segmentsForActiveSlice() {
  const active = state.activeSlice;
  if (!active) return [];
  const payload = state.slices[active.dimension];
  if (!payload) return [];
  if (active.dimension !== "demographic") {
    return payload.segments.filter((segment) => segment.key === active.value);
  }
  const [kind, value] = active.value.split(":");
  if (kind === "gender") {
    return payload.segments.filter((segment) => segment.gender === value);
  }
  if (kind === "age") {
    return payload.segments.filter((segment) => segment.age === value);
  }
  return payload.segments.filter((segment) => segment.key === value);
}

function deliverySliceFor(row) {
  if (!state.activeSlice) return row;
  const totals = { spend: 0, impressions: 0, clicks: 0 };
  for (const segment of segmentsForActiveSlice()) {
    const metrics = segment.creatives[row.creativeId];
    if (!metrics) continue;
    totals.spend += metrics.spend;
    totals.impressions += metrics.impressions;
    totals.clicks += metrics.clicks;
  }
  const cpc = totals.clicks ? totals.spend / totals.clicks : 0;
  const cpm = totals.impressions
    ? (totals.spend / totals.impressions) * 1000
    : 0;
  const ctr = totals.impressions
    ? (totals.clicks / totals.impressions) * 100
    : 0;
  return {
    ...row,
    metaSpend: totals.spend,
    metaImpressions: totals.impressions,
    metaClicks: totals.clicks,
    metaCpc: cpc,
    metaCpm: cpm,
    metaCtr: ctr,
    _sliceActive: true,
  };
}

function filteredRows() {
  if (!state.payload) return [];
  const query = $("searchInput").value.trim().toLowerCase();
  const mediaType = $("mediaType").value;
  const slice = $("performanceSlice").value;
  const minSpend = Number($("minimumSpend").value);
  const sort = $("sortMetric").value;

  const rows = state.payload.creatives.map(deliverySliceFor).filter((row) => {
    const haystack = [
      row.creativeName,
      ...(row.metaCreativeNames || []),
      ...(row.media || []).map((item) => item.adName),
    ]
      .join(" ")
      .toLowerCase();
    if (query && !haystack.includes(query)) return false;
    if (row.metaSpend < minSpend) return false;
    if (mediaType !== "all" && mediaTypeFor(row) !== mediaType) return false;
    if (slice === "scale" && row.metaSpend < 5000) return false;
    if (slice === "efficient" && !(row.cpi > 0 && row.cpi <= 20)) return false;
    if (
      slice === "retention" &&
      !(
        row.adjustRetentionDenD7 > 0 &&
        row.adjustRetentionD7 >= 12
      )
    )
      return false;
    if (slice === "watch" && row.cpi < 25) return false;
    return true;
  });

  const comparators = {
    spend: (a, b) => b.metaSpend - a.metaSpend,
    installs: (a, b) => b.adjustInstalls - a.adjustInstalls,
    cpi: (a, b) => (a.cpi || Infinity) - (b.cpi || Infinity),
    cvr: (a, b) => b.cvr - a.cvr,
    ctr: (a, b) => b.metaCtr - a.metaCtr,
    d7: (a, b) =>
      (b.adjustRetentionDenD7 > 0 ? b.adjustRetentionD7 : -1) -
      (a.adjustRetentionDenD7 > 0 ? a.adjustRetentionD7 : -1),
  };
  return rows.sort(comparators[sort] || comparators.spend);
}

function mediaMarkup(row, index) {
  const media = row.media[0];
  if (!media) {
    const pending = state.payload?.dataHealth?.status === "loading";
    return `<div class="media-frame"><div class="media-empty">${pending ? "Loading preview…" : "No Meta preview<br>for this grouping"}</div></div>`;
  }
  const thumbnail = safeUrl(media.thumbnailUrl);
  const directVideo = safeUrl(media.videoUrl);
  const image = thumbnail
    ? `<img loading="${index < 8 ? "eager" : "lazy"}" src="${escapeHtml(thumbnail)}" alt="${escapeHtml(row.creativeName)}" />`
    : directVideo
      ? `<video muted playsinline preload="metadata" src="${escapeHtml(directVideo)}" aria-label="${escapeHtml(row.creativeName)}"></video>`
      : `<div class="media-empty">Preview available on open</div>`;
  const play =
    media.mediaType === "video"
      ? '<button class="play-button" aria-hidden="true" tabindex="-1">▶</button>'
      : "";
  return `
    <div class="media-frame" data-frame="${escapeHtml(row.creativeId)}"${
      media.mediaType === "video"
        ? ` data-play="${escapeHtml(media.adId)}" role="button" tabindex="0" aria-label="Play ${escapeHtml(row.creativeName)}"`
        : ""
    }>
      ${image}${play}
      <span class="media-tag">${escapeHtml(media.mediaType)}</span>
      ${row.media.length > 1 ? `<span class="variant-count">${row.media.length} variants</span>` : ""}
    </div>`;
}

function renderSummary() {
  let t = state.payload?.totals;
  if (!t) return;
  if (state.activeSlice) {
    const rows = state.payload.creatives.map(deliverySliceFor);
    const spend = rows.reduce((sum, row) => sum + row.metaSpend, 0);
    const impressions = rows.reduce(
      (sum, row) => sum + row.metaImpressions,
      0,
    );
    const clicks = rows.reduce((sum, row) => sum + row.metaClicks, 0);
    t = {
      spend,
      impressions,
      clicks,
      installs: null,
      cpc: clicks ? spend / clicks : 0,
      cpm: impressions ? (spend / impressions) * 1000 : 0,
      ctr: impressions ? (clicks / impressions) * 100 : 0,
      cvr: null,
      cpi: null,
    };
    $("sliceNotice").textContent =
      `${state.activeSlice.label} delivery slice applied. ` +
      "Spend, impressions, clicks, CPM, CTR and CPC are sliced from Meta. " +
      "Card installs, CPI, CVR and retention remain all-audience Adjust metrics.";
    $("sliceNotice").classList.remove("hidden");
  } else {
    $("sliceNotice").classList.add("hidden");
  }
  const items = [
    ["Spend", money(t.spend, true)],
    ["Impressions", compact(t.impressions)],
    ["Clicks", compact(t.clicks)],
    ["Installs", t.installs == null ? "All aud." : compact(t.installs)],
    ["CPC", money(t.cpc)],
    ["CPM", money(t.cpm)],
    ["CTR", pct(t.ctr)],
    ["CVR", t.cvr == null ? "All aud." : pct(t.cvr)],
    ["CPI", t.cpi == null ? "All aud." : money(t.cpi)],
  ];
  $("summaryStrip").innerHTML = items
    .map(
      ([label, value]) =>
        `<div class="summary-item"><span>${label}</span><strong>${value}</strong></div>`,
    )
    .join("");
}

const metricDefinitions = [
  ["Spend", "Adjust network_cost", "Sum of attributed media cost for the selected population and date range."],
  ["CTR", "Meta / Adjust delivery", "Clicks ÷ impressions × 100."],
  ["CPM", "Meta / Adjust delivery", "Spend ÷ impressions × 1,000."],
  ["CPI", "Adjust", "Spend ÷ installs."],
  ["CVR", "Adjust", "Installs ÷ clicks × 100."],
  ["CPSU", "Adjust", "Spend ÷ post-install account-created events."],
  ["D1 / D3 / D7", "Adjust mature cohorts", "Retained users ÷ installs from fully matured UTC calendar cohorts. Immature cohorts are excluded."],
  ["Cost per retained user", "Adjust mature cohorts", "Spend from the same mature cohort ÷ retained users. This avoids charging immature spend against a mature numerator."],
  ["Hook rate", "Meta video insights", "Three-second video views ÷ impressions."],
  ["Hold rate", "Meta video insights", "ThruPlays ÷ three-second video views."],
  ["Testing verdict", "Creative Intelligence", "Testing-only retained-user efficiency. Scaled delivery never changes the original verdict."],
];

function renderDataHealth() {
  const health = state.payload?.dataHealth;
  if (!health) return;
  const coverage = health.coverage;
  const banner = $("dataHealthBanner");
  banner.className = `data-health-banner ${health.status}`;
  if (health.status === "loading") {
    banner.innerHTML =
      "<span></span><strong>Performance ready</strong>" +
      `<small>Loading previews in the background · ${coverage.matureD7Creatives} mature D7</small>`;
  } else {
    banner.innerHTML =
      `<span></span><strong>${health.status === "healthy" ? "Data healthy" : "Data degraded"}</strong>` +
      `<small>${coverage.creativesWithPreview}/${coverage.creatives} previews · ${coverage.previewSpendPct.toFixed(1)}% spend covered · ${coverage.matureD7Creatives} mature D7</small>`;
  }
  banner.classList.remove("hidden");
}

function renderMetricDictionary() {
  const health = state.payload?.dataHealth;
  const healthMarkup = health
    ? `<section class="metric-health">
        <h3>Current data health</h3>
        <div><span>Adjust</span><strong>${health.sources.adjust}</strong></div>
        <div><span>Meta</span><strong>${health.sources.meta}</strong></div>
        <div><span>AdManage</span><strong>${health.sources.adManage}</strong></div>
        <div><span>Matched ads</span><strong>${integer(health.coverage.matchedAds)}/${integer(health.coverage.ads)}</strong></div>
        <div><span>Preview spend coverage</span><strong>${pct(health.coverage.previewSpendPct)}</strong></div>
        <div><span>Mature D1 / D3 / D7</span><strong>${integer(health.coverage.matureD1Creatives)} / ${integer(health.coverage.matureD3Creatives)} / ${integer(health.coverage.matureD7Creatives)}</strong></div>
      </section>`
    : "";
  $("metricDictionary").innerHTML =
    healthMarkup +
    `<div class="metric-definition-list">${metricDefinitions
      .map(
        ([metric, source, definition]) => `<section>
          <h3>${escapeHtml(metric)}</h3>
          <span>${escapeHtml(source)}</span>
          <p>${escapeHtml(definition)}</p>
        </section>`,
      )
      .join("")}</div>`;
}

function renderCompareTray() {
  const count = state.compareIds.size;
  $("compareTray").classList.toggle("hidden", count === 0);
  $("compareCount").textContent = `${count} creative${count === 1 ? "" : "s"} pinned`;
  $("compareNowButton").disabled = count < 2;
}

function openComparison() {
  const rows = [...state.compareIds]
    .map((creativeId) =>
      state.payload?.creatives.find((row) => row.creativeId === creativeId),
    )
    .filter(Boolean);
  if (rows.length < 2) return;
  const metrics = [
    ["Spend", (row) => money(row.metaSpend)],
    ["Impressions", (row) => integer(row.metaImpressions)],
    ["Clicks", (row) => integer(row.metaClicks)],
    ["Installs", (row) => integer(row.adjustInstalls)],
    ["CPM", (row) => money(row.metaCpm)],
    ["CTR", (row) => pct(row.metaCtr)],
    ["CPI", (row) => money(row.cpi)],
    ["CVR", (row) => pct(row.cvr)],
    ["D1", (row) => retentionPct(row.adjustRetentionD1, row.adjustRetentionDenD1)],
    ["D3", (row) => retentionPct(row.adjustRetentionD3, row.adjustRetentionDenD3)],
    ["D7", (row) => retentionPct(row.adjustRetentionD7, row.adjustRetentionDenD7)],
  ];
  state.detail = null;
  state.debriefDetail = null;
  $("dialogContent").innerHTML = `
    <div class="compare-shell">
      <header class="detail-header"><strong>Creative comparison</strong><div>${rows.length} pinned</div></header>
      <div class="compare-scroll">
        <table class="compare-table">
          <thead><tr><th>Metric</th>${rows
            .map((row) => {
              const thumb = safeUrl(row.media[0]?.thumbnailUrl);
              return `<th>${thumb ? `<img src="${escapeHtml(thumb)}" alt="" />` : ""}<strong>${escapeHtml(row.creativeName)}</strong></th>`;
            })
            .join("")}</tr></thead>
          <tbody>${metrics
            .map(
              ([label, valueFor]) =>
                `<tr><th>${label}</th>${rows.map((row) => `<td>${valueFor(row)}</td>`).join("")}</tr>`,
            )
            .join("")}</tbody>
        </table>
      </div>
    </div>`;
  if (!dialog.open) dialog.showModal();
}

function exportFilteredCsv() {
  const rows = filteredRows();
  const headers = [
    "Creative",
    "Meta aliases",
    "Spend",
    "Impressions",
    "Clicks",
    "Installs",
    "CPM",
    "CTR",
    "CPC",
    "CPI",
    "CVR",
    "D1",
    "D1 retained",
    "D1 mature N",
    "D3",
    "D3 retained",
    "D3 mature N",
    "D7",
    "D7 retained",
    "D7 mature N",
  ];
  const values = rows.map((row) => [
    row.creativeName,
    (row.metaCreativeNames || []).join(" | "),
    row.metaSpend,
    row.metaImpressions,
    row.metaClicks,
    row.adjustInstalls,
    row.metaCpm,
    row.metaCtr,
    row.metaCpc,
    row.cpi,
    row.cvr,
    row.adjustRetentionDenD1 > 0 ? row.adjustRetentionD1 : "",
    row.adjustRetainedD1,
    row.adjustRetentionDenD1,
    row.adjustRetentionDenD3 > 0 ? row.adjustRetentionD3 : "",
    row.adjustRetainedD3,
    row.adjustRetentionDenD3,
    row.adjustRetentionDenD7 > 0 ? row.adjustRetentionD7 : "",
    row.adjustRetainedD7,
    row.adjustRetentionDenD7,
  ]);
  const csv = [headers, ...values]
    .map((line) =>
      line
        .map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`)
        .join(","),
    )
    .join("\\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
  );
  link.download =
    `creative-intelligence-${state.payload?.range.since}-${state.payload?.range.until}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function currentLibraryUrl() {
  const params = currentRangeParams();
  params.set("page", "library");
  params.set("sort", $("sortMetric").value);
  params.set("media", $("mediaType").value);
  params.set("performance", $("performanceSlice").value);
  params.set("minSpend", $("minimumSpend").value);
  const search = $("searchInput").value.trim();
  if (search) params.set("search", search);
  if (state.activeSlice) {
    const parameter = {
      publisher: "audience",
      demographic: "demographic",
      device: "device",
      os: "os",
    }[state.activeSlice.dimension];
    if (parameter) params.set(parameter, state.activeSlice.value);
  }
  return `/?${params.toString()}`;
}

async function saveCurrentView() {
  const name = window.prompt("Name this report view:");
  if (!name?.trim()) return;
  const response = await fetch("/api/saved-reports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.trim(), url: currentLibraryUrl() }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not save view");
  await loadWorkspace();
}

async function copySlackSummary() {
  const rows = filteredRows().slice(0, 5);
  const range = state.payload?.range;
  const lines = [
    `*Creative performance · ${range?.since} → ${range?.until}*`,
    ...rows.map(
      (row, index) =>
        `${index + 1}. *${row.creativeName}* — ${money(row.metaSpend, true)} spend · ${money(row.cpi)} CPI · ${retentionPct(row.adjustRetentionD7, row.adjustRetentionDenD7)} D7`,
    ),
    `<${window.location.origin}${currentLibraryUrl()}|Open filtered dashboard>`,
  ];
  await navigator.clipboard.writeText(lines.join("\\n"));
  $("copySlackSummaryButton").textContent = "Copied";
  setTimeout(() => {
    $("copySlackSummaryButton").textContent = "Copy Slack summary";
  }, 1_500);
}

function renderWorkspace() {
  $("savedReportsList").innerHTML =
    state.savedReports
      .map(
        (report) => `<div class="workspace-item">
          <a href="${escapeHtml(report.url)}">${escapeHtml(report.name)}</a>
          <span>${new Date(report.createdAt).toLocaleString()}</span>
          <button data-delete-report="${escapeHtml(report.id)}">Delete</button>
        </div>`,
      )
      .join("") || '<div class="analysis-empty">No saved views yet.</div>';
  $("testBriefsList").innerHTML =
    state.testBriefs
      .map(
        (brief) => `<div class="workspace-item">
          <div><strong>${escapeHtml(brief.title)}</strong><small>${escapeHtml(brief.sourceBrand)} · ${escapeHtml(brief.status)}</small><p>${escapeHtml(brief.hypothesis || "No hypothesis yet.")}</p></div>
        </div>`,
      )
      .join("") || '<div class="analysis-empty">No competitor briefs yet.</div>';
}

async function loadWorkspace() {
  const [reportsResponse, briefsResponse] = await Promise.all([
    fetch("/api/saved-reports"),
    fetch("/api/test-briefs"),
  ]);
  const reports = await reportsResponse.json();
  const briefs = await briefsResponse.json();
  state.savedReports = reports.reports || [];
  state.testBriefs = briefs.briefs || [];
  renderWorkspace();
}

function renderExperiments() {
  const warningsFor = (experiment) =>
    [
      !experiment.control && "No fixed control",
      !experiment.variants && "No variants defined",
      !experiment.guardrails && "No guardrails",
      !experiment.owner && "No owner",
    ].filter(Boolean);
  $("experimentList").innerHTML =
    state.experiments.length > 0
      ? `<table class="analysis-data-table debrief-table">
          <thead><tr><th class="sticky-cell">Experiment</th><th>Status</th><th>Owner</th><th>Hypothesis</th><th>Primary metric</th><th>Guardrails</th><th>Confound checks</th><th>Updated</th><th></th></tr></thead>
          <tbody>${state.experiments
            .map((experiment) => {
              const warnings = warningsFor(experiment);
              return `<tr>
                <td class="sticky-cell"><strong>${escapeHtml(experiment.name)}</strong></td>
                <td>${escapeHtml(experiment.status)}</td>
                <td>${escapeHtml(experiment.owner || "—")}</td>
                <td class="debrief-reasons">${escapeHtml(experiment.hypothesis)}</td>
                <td>${escapeHtml(experiment.primaryMetric)}</td>
                <td>${escapeHtml(experiment.guardrails || "—")}</td>
                <td>${warnings.length ? warnings.map((warning) => `<span class="experiment-warning">${escapeHtml(warning)}</span>`).join("") : '<span class="experiment-ready">Ready</span>'}</td>
                <td>${new Date(experiment.updatedAt).toLocaleDateString()}</td>
                <td><button data-edit-experiment="${escapeHtml(experiment.id)}">Edit</button><button data-delete-experiment="${escapeHtml(experiment.id)}">Delete</button></td>
              </tr>`;
            })
            .join("")}</tbody>
        </table>`
      : '<div class="analysis-empty">No experiments registered yet.</div>';
}

async function loadExperiments() {
  const response = await fetch("/api/experiments");
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Experiments unavailable");
  state.experiments = data.experiments || [];
  renderExperiments();
}

function clearExperimentForm() {
  $("experimentForm").reset();
  $("experimentId").value = "";
}

async function saveExperiment(event) {
  event.preventDefault();
  const payload = {
    id: $("experimentId").value || undefined,
    name: $("experimentName").value,
    owner: $("experimentOwner").value,
    status: $("experimentStatus").value,
    hypothesis: $("experimentHypothesis").value,
    control: $("experimentControl").value,
    variants: $("experimentVariants").value,
    primaryMetric: $("experimentPrimaryMetric").value,
    guardrails: $("experimentGuardrails").value,
    notes: $("experimentNotes").value,
  };
  const response = await fetch("/api/experiments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not save experiment");
  clearExperimentForm();
  await loadExperiments();
}

function render() {
  const rows = filteredRows();
  $("resultCount").textContent = `${rows.length} of ${
    state.payload?.creatives.length ?? 0
  } results`;
  if (!rows.length) {
    grid.innerHTML =
      '<div class="empty-state">No creatives match these filters.</div>';
    return;
  }

  grid.innerHTML = rows
    .map((row, index) => {
      const [metricLabel, metricValue] = primaryMetric(row);
      const aliases = (row.metaCreativeNames || []).filter(
        (name) => name !== row.creativeName,
      );
      const efficient = row.cpi > 0 && row.cpi <= 20;
      const watch = row.cpi >= 25;
      const status = efficient ? "Efficient" : watch ? "Watch" : "Active";
      const overallMark = state.activeSlice ? "*" : "";
      return `
        <article class="creative-card" data-creative="${escapeHtml(row.creativeId)}">
          <span class="rank-badge">#${index + 1}</span>
          ${mediaMarkup(row, index)}
          <div class="card-body">
            <div class="creative-name">${escapeHtml(row.creativeName)}</div>
            <div class="alias-line">${aliases.length ? `Meta: ${escapeHtml(aliases[0])}` : `${row.adCount} ad${row.adCount === 1 ? "" : "s"}`}</div>
            <div class="primary-metric"><span>${metricLabel}</span><strong>${metricValue}</strong></div>
            <div class="metric-grid">
              <div class="metric-cell"><span>Installs${overallMark}</span><strong>${integer(row.adjustInstalls)}</strong></div>
              <div class="metric-cell"><span>CPI${overallMark}</span><strong>${money(row.cpi)}</strong></div>
              <div class="metric-cell"><span>CTR</span><strong>${pct(row.metaCtr)}</strong></div>
              <div class="metric-cell"><span>D7${overallMark}</span><strong>${retentionPct(row.adjustRetentionD7, row.adjustRetentionDenD7)}</strong></div>
            </div>
            <div class="card-footer">
              <span class="status-pill ${watch ? "watch" : ""}">${status}</span>
              <button class="compare-button ${state.compareIds.has(row.creativeId) ? "active" : ""}" data-compare="${escapeHtml(row.creativeId)}">${state.compareIds.has(row.creativeId) ? "Pinned" : "Pin"}</button>
              <button class="details-button" data-details="${escapeHtml(row.creativeId)}">Full metrics →</button>
            </div>
          </div>
        </article>`;
    })
    .join("");

  grid.querySelectorAll("[data-play]").forEach((frame) => {
    const play = (event) => {
      event.stopPropagation();
      void playPreview(frame, frame.dataset.play);
    };
    frame.addEventListener("click", play);
    frame.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      play(event);
    });
  });
  grid.querySelectorAll("[data-details]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void openDetail(button.dataset.details);
    });
  });
  grid.querySelectorAll("[data-compare]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const creativeId = button.dataset.compare;
      if (state.compareIds.has(creativeId)) {
        state.compareIds.delete(creativeId);
      } else if (state.compareIds.size < 5) {
        state.compareIds.add(creativeId);
      }
      render();
    });
  });
  grid.querySelectorAll(".creative-card").forEach((card) => {
    card.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      void openDetail(card.dataset.creative);
    });
  });
  renderCompareTray();
}

async function playPreview(frame, adId) {
  if (!frame || !adId) return;
  frame.removeAttribute("data-play");
  frame.removeAttribute("role");
  frame.removeAttribute("tabindex");
  frame.removeAttribute("aria-label");
  const media = state.payload?.creatives
    .flatMap((row) => row.media)
    .find((item) => item.adId === adId);
  const directVideo = safeUrl(media?.videoUrl);
  if (directVideo) {
    const poster = safeUrl(media?.thumbnailUrl);
    frame.innerHTML = `<video controls autoplay playsinline src="${escapeHtml(directVideo)}"${
      poster ? ` poster="${escapeHtml(poster)}"` : ""
    } aria-label="${escapeHtml(media?.adName || "Creative video")}"></video>`;
    const player = frame.querySelector("video");
    player?.addEventListener(
      "error",
      () => void loadMetaPreview(frame, adId),
      { once: true },
    );
    void player?.play().catch(() => {
      // Controls remain available when the browser blocks autoplay.
    });
    return;
  }
  await loadMetaPreview(frame, adId);
}

async function loadMetaPreview(frame, adId) {
  frame.innerHTML = '<div class="spinner"></div>';
  try {
    const response = await fetch(`/api/preview?adId=${encodeURIComponent(adId)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Preview unavailable");
    const src = safeUrl(data.src);
    if (!src) throw new Error("Unsafe preview URL");
    frame.innerHTML = `<iframe src="${escapeHtml(src)}" allow="autoplay; fullscreen" title="Meta ad preview"></iframe>`;
  } catch (error) {
    frame.innerHTML = `<div class="media-empty">${escapeHtml(error.message)}</div>`;
  }
}

function metricGrid(row) {
  const overall = state.activeSlice ? " · all aud." : "";
  const metrics = [
    ["Spend", money(row.metaSpend)],
    ["Impressions", integer(row.metaImpressions)],
    ["Clicks", integer(row.metaClicks)],
    [`Installs${overall}`, integer(row.adjustInstalls)],
    ["CPM", money(row.metaCpm)],
    ["CTR", pct(row.metaCtr)],
    ["CPC", money(row.metaCpc)],
    [`CVR${overall}`, pct(row.cvr)],
    [`CPI${overall}`, money(row.cpi)],
    [`D1${overall}`, retentionPct(row.adjustRetentionD1, row.adjustRetentionDenD1)],
    [`D3${overall}`, retentionPct(row.adjustRetentionD3, row.adjustRetentionDenD3)],
    [`D7${overall}`, retentionPct(row.adjustRetentionD7, row.adjustRetentionDenD7)],
  ];
  return metrics
    .map(
      ([label, value]) =>
        `<div><span>${label}</span><strong>${value}</strong></div>`,
    )
    .join("");
}

function trendChart(points, compactChart = false) {
  if (!points?.length) {
    return '<div class="chart-empty">Daily trend unavailable</div>';
  }
  const max = Math.max(...points.map((point) => point.spend), 1);
  return `
    <div class="trend-chart ${compactChart ? "compact" : ""}">
      ${points
        .map(
          (point) => `
            <div class="trend-column" title="${escapeHtml(point.date)} · ${money(point.spend)}">
              <div class="trend-bar" style="height:${Math.max(3, (point.spend / max) * 100)}%"></div>
              <span>${escapeHtml(point.date.slice(5))}</span>
            </div>`,
        )
        .join("")}
    </div>`;
}

function creativeDistribution(dimension, row) {
  const payload = state.slices[dimension];
  if (!payload) return [];
  return payload.segments
    .map((segment) => ({
      key: segment.key,
      label: segment.label,
      age: segment.age,
      gender: segment.gender,
      value: segment.creatives[row.creativeId]?.spend ?? 0,
    }))
    .filter((item) => item.value > 0);
}

function aggregateDistribution(items, property, labelFn = (value) => value) {
  const values = new Map();
  for (const item of items) {
    const key = item[property] || "Unknown";
    values.set(key, (values.get(key) || 0) + item.value);
  }
  return [...values.entries()]
    .map(([key, value]) => ({ key, label: labelFn(key), value }))
    .sort((a, b) => b.value - a.value);
}

function barsPanel(title, items) {
  const total = items.reduce((sum, item) => sum + item.value, 0) || 1;
  return `
    <section class="insight-panel">
      <h4>${escapeHtml(title)}</h4>
      <div class="distribution-bars">
        ${items
          .map(
            (item) => `
              <div class="distribution-row">
                <span>${escapeHtml(item.label)}</span>
                <div><i style="width:${(item.value / total) * 100}%"></i></div>
                <strong>${money(item.value, true)}</strong>
              </div>`,
          )
          .join("") || '<p class="subtle">No delivery</p>'}
      </div>
    </section>`;
}

function donutPanel(title, items) {
  const total = items.reduce((sum, item) => sum + item.value, 0) || 1;
  const colors = ["#63d6a2", "#5b9df5", "#f3b45d", "#de7ad8", "#8d96a1"];
  let cursor = 0;
  const stops = items.map((item, index) => {
    const start = cursor;
    cursor += (item.value / total) * 100;
    return `${colors[index % colors.length]} ${start}% ${cursor}%`;
  });
  return `
    <section class="insight-panel">
      <h4>${escapeHtml(title)}</h4>
      <div class="donut-wrap">
        <div class="donut" style="background:conic-gradient(${stops.join(",") || "#30353b 0 100%"})"></div>
        <div class="donut-legend">
          ${items
            .map(
              (item, index) =>
                `<div><i style="background:${colors[index % colors.length]}"></i><span>${escapeHtml(item.label)}</span><strong>${((item.value / total) * 100).toFixed(1)}%</strong></div>`,
            )
            .join("")}
        </div>
      </div>
    </section>`;
}

function selectedDetailMedia() {
  const detail = state.detail;
  if (!detail) return null;
  return (
    detail.row.media.find((item) => item.adId === detail.selectedAdId) ??
    detail.row.media[0] ??
    null
  );
}

function detailOverview(row, media) {
  const trendLabel = state.activeSlice ? " · all audience" : "";
  return `
    <div class="overview-grid">
      <section class="detail-section key-metric-card">
        <span>Amount spent</span><strong>${money(row.metaSpend)}</strong>
      </section>
      <section class="detail-section trend-card">
        <div class="section-title">Meta daily spend trend${trendLabel}</div>
        ${trendChart(state.detail.trend, true)}
      </section>
    </div>
    <section class="detail-section">
      <div class="section-title">Platform</div>
      <div class="platform-pills"><span>Meta</span><span>${escapeHtml(media?.status || "Unknown")}</span><span>${escapeHtml(media?.mediaType || "Unknown")}</span></div>
    </section>
    <section class="detail-section hierarchy">
      <div class="section-title">Ad hierarchy</div>
      <dl>
        <div><dt>Campaign</dt><dd>${escapeHtml(media?.campaignName || "Unavailable")}</dd></div>
        <div><dt>Ad set</dt><dd>${escapeHtml(media?.adSetName || "Unavailable")}</dd></div>
        <div><dt>Ad</dt><dd>${escapeHtml(media?.adName || row.creativeName)}</dd></div>
        <div><dt>Ad ID</dt><dd>${escapeHtml(media?.adId || "—")}</dd></div>
        <div><dt>Headline</dt><dd>${escapeHtml(media?.headline || "—")}</dd></div>
        <div class="wide"><dt>Primary text</dt><dd>${escapeHtml(media?.primaryText || "—")}</dd></div>
        <div class="wide"><dt>Description</dt><dd>${escapeHtml(media?.description || "—")}</dd></div>
      </dl>
    </section>`;
}

function videoFunnelMarkup(video, compactView = false) {
  if (!video || !video.videoStarts) {
    return '<div class="analysis-empty">No video-view metrics for this selection.</div>';
  }
  const base = Math.max(video.threeSecondViews, 1);
  const stages = [
    ["Video starts", video.videoStarts, null],
    ["3-second views", video.threeSecondViews, video.hookRate],
    ["25% watched", video.p25, video.p25Rate],
    ["50% watched", video.p50, video.p50Rate],
    ["75% watched", video.p75, video.p75Rate],
    ["100% watched", video.p100, video.completionRate],
    ["ThruPlays", video.thruPlays, video.holdRate],
  ];
  return `
    <div class="video-kpis">
      <div><span>Hook rate</span><strong>${pct(video.hookRate)}</strong><small>3s views / impressions</small></div>
      <div><span>Hold rate</span><strong>${pct(video.holdRate)}</strong><small>ThruPlay / 3s views</small></div>
      <div><span>Completion</span><strong>${pct(video.completionRate)}</strong><small>100% / 3s views</small></div>
      <div><span>Avg. watch</span><strong>${Number(video.avgWatchSeconds || 0).toFixed(1)}s</strong><small>Meta reported average</small></div>
    </div>
    <div class="video-funnel ${compactView ? "compact" : ""}">
      ${stages
        .map(
          ([label, value, rate]) => `
            <div><span>${label}</span><i><b style="width:${Math.min(100, (Number(value) / base) * 100)}%"></b></i><strong>${compact(value)}${rate == null ? "" : ` · ${pct(rate)}`}</strong></div>`,
        )
        .join("")}
    </div>`;
}

function detailPerformance(row) {
  const video = state.videoMetrics?.creatives?.[row.creativeId];
  return `
    <section class="detail-section">
      <div class="section-title">Meta daily spend trend${state.activeSlice ? " · all audience" : ""}</div>
      ${trendChart(state.detail.trend)}
    </section>
    <div class="performance-panels">
      <section class="detail-section"><div class="section-title">Core</div>
        <div class="list-metrics">
          <div><span>Spend</span><strong>${money(row.metaSpend)}</strong></div>
          <div><span>Impressions</span><strong>${integer(row.metaImpressions)}</strong></div>
          <div><span>Clicks</span><strong>${integer(row.metaClicks)}</strong></div>
          <div><span>Installs${state.activeSlice ? " · all aud." : ""}</span><strong>${integer(row.adjustInstalls)}</strong></div>
        </div>
      </section>
      <section class="detail-section"><div class="section-title">Efficiency</div>
        <div class="list-metrics">
          <div><span>CPM</span><strong>${money(row.metaCpm)}</strong></div>
          <div><span>CPC</span><strong>${money(row.metaCpc)}</strong></div>
          <div><span>CTR</span><strong>${pct(row.metaCtr)}</strong></div>
          <div><span>CPI · all aud.</span><strong>${money(row.cpi)}</strong></div>
        </div>
      </section>
      <section class="detail-section"><div class="section-title">Retention · all audience</div>
        <div class="list-metrics">
          <div><span>D1</span><strong>${retentionPct(row.adjustRetentionD1, row.adjustRetentionDenD1)} · ${integer(row.adjustRetainedD1)}/${integer(row.adjustRetentionDenD1)}</strong></div>
          <div><span>D3</span><strong>${retentionPct(row.adjustRetentionD3, row.adjustRetentionDenD3)} · ${integer(row.adjustRetainedD3)}/${integer(row.adjustRetentionDenD3)}</strong></div>
          <div><span>D7</span><strong>${retentionPct(row.adjustRetentionD7, row.adjustRetentionDenD7)} · ${integer(row.adjustRetainedD7)}/${integer(row.adjustRetentionDenD7)}</strong></div>
          <div><span>CVR</span><strong>${pct(row.cvr)}</strong></div>
        </div>
      </section>
    </div>
    <section class="detail-section"><div class="section-title">Video analysis · raw Meta data</div>${videoFunnelMarkup(video, true)}</section>`;
}

function colorCss(name) {
  const key = String(name || "").toLowerCase();
  const colors = {
    black: "#1b1d20",
    white: "#f3f4f5",
    red: "#e05252",
    orange: "#e58b3c",
    yellow: "#e3c642",
    green: "#4daa70",
    teal: "#3fa9a3",
    blue: "#4d7ed6",
    purple: "#865bc2",
    pink: "#dc6fa8",
    brown: "#8b6549",
    gray: "#8b929a",
    grey: "#8b929a",
    beige: "#d7c6a6",
    gold: "#c8a747",
  };
  return (
    Object.entries(colors).find(([color]) => key.includes(color))?.[1] ??
    "#8b929a"
  );
}

function colorProfileMarkup(analysis) {
  const color = analysis?.colorTheory;
  const composition = analysis?.composition;
  if (!color || !composition) {
    return '<div class="analysis-empty">Rescan this creative for color and composition analysis.</div>';
  }
  return `
    <div class="color-profile">
      <div class="palette-row">${color.primaryColors
        .map(
          (name) =>
            `<span title="${escapeHtml(name)}" style="background:${colorCss(name)}"></span>`,
        )
        .join("")}</div>
      <dl>
        <div><dt>Harmony</dt><dd>${escapeHtml(color.harmony)}</dd></div>
        <div><dt>Temperature</dt><dd>${escapeHtml(color.paletteTemperature)}</dd></div>
        <div><dt>Contrast</dt><dd>${escapeHtml(color.contrast)}</dd></div>
        <div><dt>Saturation</dt><dd>${escapeHtml(color.saturation)}</dd></div>
        <div><dt>Brightness</dt><dd>${escapeHtml(color.brightness)}</dd></div>
        <div><dt>Text legibility</dt><dd>${escapeHtml(color.textLegibility)}</dd></div>
      </dl>
      <p><strong>Color strategy:</strong> ${escapeHtml(color.colorStrategy)}</p>
      <p><strong>Visual hierarchy:</strong> ${escapeHtml(composition.visualHierarchy)}</p>
    </div>`;
}

function detailInsights(row) {
  const demographic = creativeDistribution("demographic", row);
  const ages = aggregateDistribution(demographic, "age");
  const genders = aggregateDistribution(demographic, "gender", (value) =>
    value === "female" ? "Women" : value === "male" ? "Men" : "Unknown",
  );
  const publishers = creativeDistribution("publisher", row);
  const devices = creativeDistribution("device", row);
  const operatingSystems = creativeDistribution("os", row);
  const analysis = analysisMap().get(row.creativeId);
  return `
    <div class="insights-heading">
      <div><h3>Audience breakdown</h3><p>Meta spend by age, gender, platform, device, and operating system</p></div>
      <span>Spend</span>
    </div>
    <div class="insights-grid">
      ${barsPanel("Age distribution", ages)}
      ${donutPanel("Gender distribution", genders)}
      ${barsPanel("Platform distribution", publishers)}
      ${donutPanel("Device distribution", devices)}
      ${donutPanel("Operating system", operatingSystems)}
      <section class="insight-panel color-insight"><h4>Color + composition</h4>${colorProfileMarkup(analysis)}</section>
    </div>`;
}

function renderDetail() {
  const detail = state.detail;
  if (!detail) return;
  const row = deliverySliceFor(detail.row);
  const media = selectedDetailMedia();
  const thumbnail = safeUrl(media?.thumbnailUrl);
  const directVideo = safeUrl(media?.videoUrl);
  const previewSrc = safeUrl(
    media ? detail.previewByAd[media.adId] : "",
  );
  const aliases = (row.metaCreativeNames || [])
    .map((name) => `<li>${escapeHtml(name)}</li>`)
    .join("");
  const variants = row.media
    .map((item, index) => {
      const thumb = safeUrl(item.thumbnailUrl);
      return `<button class="variant-button ${item.adId === detail.selectedAdId ? "active" : ""}" data-variant="${escapeHtml(item.adId)}" title="${escapeHtml(item.adName)}">${
        thumb ? `<img src="${escapeHtml(thumb)}" alt="" />` : escapeHtml(index + 1)
      }</button>`;
    })
    .join("");
  const pane =
    detail.tab === "performance"
      ? detailPerformance(row)
      : detail.tab === "insights"
        ? detailInsights(row)
        : detailOverview(row, media);

  $("dialogContent").innerHTML = `
    <div class="detail-shell">
      <header class="detail-header">
        <strong>${escapeHtml(row.creativeName)}</strong>
        <div><span>#${detail.rank} of ${detail.total}</span><button data-detail-prev aria-label="Previous">‹</button><button data-detail-next aria-label="Next">›</button></div>
      </header>
      <div class="detail-layout">
        <aside class="detail-left">
          <div class="media-mode"><span class="active">Preview</span><span>Live</span></div>
          <div id="detailMedia" class="detail-media">
            ${
              previewSrc
                ? previewSrc === directVideo
                  ? `<video data-detail-direct-video="${escapeHtml(media.adId)}" controls autoplay playsinline src="${escapeHtml(previewSrc)}"${
                      thumbnail ? ` poster="${escapeHtml(thumbnail)}"` : ""
                    } aria-label="${escapeHtml(media.adName || row.creativeName)}"></video>`
                  : `<iframe src="${escapeHtml(previewSrc)}" allow="autoplay; fullscreen" title="Playable Meta ad preview"></iframe>`
                : thumbnail
                ? `<div class="media-frame"${
                    media?.mediaType === "video"
                      ? ` data-dialog-play="${escapeHtml(media.adId)}" role="button" tabindex="0" aria-label="Play ${escapeHtml(row.creativeName)}"`
                      : ""
                  }><img src="${escapeHtml(thumbnail)}" alt="${escapeHtml(row.creativeName)}" />${
                    media?.mediaType === "video" ? '<button class="play-button" aria-hidden="true" tabindex="-1">▶</button>' : ""
                  }</div>`
                : directVideo && media?.mediaType === "video"
                  ? `<div class="media-frame" data-dialog-play="${escapeHtml(media.adId)}" role="button" tabindex="0" aria-label="Play ${escapeHtml(row.creativeName)}"><video muted playsinline preload="metadata" src="${escapeHtml(directVideo)}"></video><button class="play-button" aria-hidden="true" tabindex="-1">▶</button></div>`
                : '<div class="media-empty">No media preview</div>'
            }
          </div>
          <div class="variant-strip">${variants}</div>
          <p class="selected-ad-name">${escapeHtml(media?.adName || "")}</p>
        </aside>
        <section class="detail-right">
          <nav class="detail-tabs">
            <button data-detail-tab="overview" class="${detail.tab === "overview" ? "active" : ""}">Overview</button>
            <button data-detail-tab="performance" class="${detail.tab === "performance" ? "active" : ""}">Performance</button>
            <button data-detail-tab="insights" class="${detail.tab === "insights" ? "active" : ""}">Insights</button>
          </nav>
          <div class="detail-pane">
            ${detail.loading ? '<div class="detail-loading">Loading daily trend…</div>' : ""}
            ${pane}
            <details class="alias-details"><summary>Adjust ↔ Meta aliases</summary><ul class="alias-list">${aliases || "<li>Same label</li>"}</ul></details>
          </div>
        </section>
      </div>
    </div>`;

  const dialogPreview = $("dialogContent").querySelector("[data-dialog-play]");
  if (dialogPreview) {
    const play = () =>
      void ensureDetailPreview(dialogPreview.dataset.dialogPlay);
    dialogPreview.addEventListener("click", play);
    dialogPreview.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      play();
    });
  }
  const directPlayer = $("dialogContent").querySelector(
    "[data-detail-direct-video]",
  );
  if (directPlayer) {
    const adId = directPlayer.dataset.detailDirectVideo;
    directPlayer.addEventListener(
      "error",
      () => {
        if (!state.detail || !adId) return;
        state.detail.directVideoFailed.add(adId);
        delete state.detail.previewByAd[adId];
        void ensureDetailPreview(adId);
      },
      { once: true },
    );
    void directPlayer.play().catch(() => {
      // Controls remain available when the browser blocks autoplay.
    });
  }
  $("dialogContent").querySelectorAll("[data-variant]").forEach((button) => {
    button.addEventListener("click", () => {
      state.detail.selectedAdId = button.dataset.variant;
      renderDetail();
    });
  });
  $("dialogContent").querySelectorAll("[data-detail-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.detail.tab = button.dataset.detailTab;
      renderDetail();
      if (state.detail.tab === "performance" && !state.videoMetrics) {
        void loadVideoMetrics();
      }
    });
  });
  $("dialogContent")
    .querySelector("[data-detail-prev]")
    ?.addEventListener("click", () => navigateDetail(-1));
  $("dialogContent")
    .querySelector("[data-detail-next]")
    ?.addEventListener("click", () => navigateDetail(1));
}

async function openDetail(creativeId) {
  let rows = filteredRows();
  let index = rows.findIndex((item) => item.creativeId === creativeId);
  if (index < 0) {
    rows = state.payload?.creatives.map(deliverySliceFor) || [];
    index = rows.findIndex((item) => item.creativeId === creativeId);
  }
  if (index < 0) return;
  const baseRow = state.payload.creatives.find(
    (item) => item.creativeId === creativeId,
  );
  if (!baseRow) return;
  state.detail = {
    row: baseRow,
    trend: [],
    loading: true,
    tab:
      ["overview", "performance", "insights"].includes(
        new URLSearchParams(window.location.search).get("tab"),
      )
        ? new URLSearchParams(window.location.search).get("tab")
        : "overview",
    selectedAdId: baseRow.media[0]?.adId ?? null,
    previewByAd: {},
    previewLoading: new Set(),
    directVideoFailed: new Set(),
    rank: index + 1,
    total: rows.length,
  };
  renderDetail();
  if (!dialog.open) dialog.showModal();
  if (state.detail.tab === "performance" && !state.videoMetrics) {
    void loadVideoMetrics();
  }

  try {
    const params = currentRangeParams();
    params.set("creativeId", creativeId);
    const response = await fetch(`/api/creative-detail?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Detail unavailable");
    if (state.detail?.row.creativeId !== creativeId) return;
    if (data.creative) {
      state.detail.row = data.creative;
      state.detail.selectedAdId ??= data.creative.media?.[0]?.adId ?? null;
    }
    state.detail.trend = data.trend || [];
  } catch {
    if (state.detail?.row.creativeId === creativeId) {
      state.detail.trend = [];
    }
  } finally {
    if (state.detail?.row.creativeId === creativeId) {
      state.detail.loading = false;
      renderDetail();
    }
  }
}

async function ensureDetailPreview(adId) {
  const detail = state.detail;
  const media = detail?.row.media.find((item) => item.adId === adId);
  if (
    !detail ||
    !media ||
    media.mediaType !== "video" ||
    detail.previewByAd[adId] ||
    detail.previewLoading.has(adId)
  ) {
    return;
  }
  const directVideo = safeUrl(media.videoUrl);
  if (directVideo && !detail.directVideoFailed.has(adId)) {
    detail.previewByAd[adId] = directVideo;
    renderDetail();
    return;
  }
  detail.previewLoading.add(adId);
  try {
    const response = await fetch(`/api/preview?adId=${encodeURIComponent(adId)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Preview unavailable");
    const src = safeUrl(data.src);
    if (!src) throw new Error("Unsafe preview URL");
    if (state.detail?.row.creativeId === detail.row.creativeId) {
      state.detail.previewByAd[adId] = src;
      renderDetail();
    }
  } catch {
    // Keep the thumbnail and manual retry button on preview failure.
  } finally {
    state.detail?.previewLoading.delete(adId);
  }
}

function navigateDetail(direction) {
  const current = state.detail;
  if (!current) return;
  const rows = filteredRows();
  const index = rows.findIndex(
    (row) => row.creativeId === current.row.creativeId,
  );
  const next = rows[(index + direction + rows.length) % rows.length];
  if (next) void openDetail(next.creativeId);
}

function currentRangeParams(force = false) {
  const preset = $("datePreset").value;
  const params = new URLSearchParams();
  if (preset === "custom") {
    params.set("since", $("sinceDate").value);
    params.set("until", $("untilDate").value);
  } else {
    params.set("days", preset);
  }
  if (force) params.set("refresh", "1");
  return params;
}

function appendOption(select, value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  select.append(option);
}

const sliceControls = {
  publisher: {
    id: "audienceSlice",
    label: "Audience All",
    parameter: "audience",
  },
  demographic: {
    id: "demographicSlice",
    label: "Demographic All",
    parameter: "demographic",
  },
  device: { id: "deviceSlice", label: "Device All", parameter: "device" },
  os: { id: "osSlice", label: "OS All", parameter: "os" },
};

function populateSliceControl(dimension) {
  const config = sliceControls[dimension];
  const select = $(config.id);
  const selected = select.value;
  select.replaceChildren();
  appendOption(select, "all", config.label);
  const segments = state.slices[dimension]?.segments || [];
  if (dimension !== "demographic") {
    for (const segment of segments) {
      appendOption(select, segment.key, segment.label);
    }
  } else {
    const genders = [
      ...new Set(segments.map((segment) => segment.gender)),
    ].filter(Boolean);
    const ages = [...new Set(segments.map((segment) => segment.age))].filter(
      Boolean,
    );
    for (const gender of genders) {
      const label =
        gender === "female" ? "Women" : gender === "male" ? "Men" : "Unknown";
      appendOption(select, `gender:${gender}`, `${label} · All ages`);
    }
    for (const age of ages) {
      appendOption(select, `age:${age}`, `Age ${age} · All genders`);
    }
    for (const segment of segments) {
      appendOption(select, `segment:${segment.key}`, segment.label);
    }
  }
  select.disabled = false;
  if ([...select.options].some((option) => option.value === selected)) {
    select.value = selected;
  }
  if (!state.initialSliceApplied) {
    const query = new URLSearchParams(window.location.search);
    const value = query.get(config.parameter);
    if (value && [...select.options].some((option) => option.value === value)) {
      state.initialSliceApplied = true;
      select.value = value;
      setActiveSlice(dimension, select);
    }
  }
}

function resetSlices() {
  state.activeSlice = null;
  state.slices = { publisher: null, demographic: null, device: null, os: null };
  state.sliceLoading.clear();
  state.initialSliceApplied = false;
  for (const config of Object.values(sliceControls)) {
    const select = $(config.id);
    select.replaceChildren();
    appendOption(select, "all", config.label);
    select.disabled = false;
  }
  $("sliceNotice").classList.add("hidden");
}

async function loadSlice(dimension, params = currentRangeParams()) {
  if (state.slices[dimension] || state.sliceLoading.has(dimension)) return;
  state.sliceLoading.add(dimension);
  const config = sliceControls[dimension];
  const select = $(config.id);
  select.options[0].textContent = `${config.label} · loading…`;
  try {
    const response = await fetch(
      `/api/slices?${params.toString()}&dimension=${dimension}`,
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `${dimension} failed`);
    const current = state.payload?.range;
    if (
      !current ||
      current.since !== data.range.since ||
      current.until !== data.range.until
    ) {
      return;
    }
    state.slices[dimension] = data;
    populateSliceControl(dimension);
    if (state.detail?.tab === "insights") renderDetail();
  } catch (error) {
    warning.textContent = `${warning.textContent || ""} Slice filters unavailable: ${error.message}`.trim();
    warning.classList.remove("hidden");
  } finally {
    state.sliceLoading.delete(dimension);
    if (!state.slices[dimension]) {
      select.options[0].textContent = config.label;
    }
  }
}

function setActiveSlice(dimension, select) {
  const value = select.value;
  for (const [otherDimension, id] of [
    ["publisher", "audienceSlice"],
    ["demographic", "demographicSlice"],
    ["device", "deviceSlice"],
    ["os", "osSlice"],
  ]) {
    if (otherDimension !== dimension) $(id).value = "all";
  }
  state.activeSlice =
    value === "all"
      ? null
      : {
          dimension,
          value,
          label: select.options[select.selectedIndex]?.text || value,
        };
  renderSummary();
  render();
}

async function loadMedia(params = currentRangeParams()) {
  const requestId = ++state.mediaRequest;
  const expectedRange = state.payload?.range;
  if (!expectedRange) return;
  try {
    const response = await fetch(`/api/creative-media?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Previews unavailable");
    if (
      requestId !== state.mediaRequest ||
      state.payload?.range.since !== data.range.since ||
      state.payload?.range.until !== data.range.until
    ) {
      return;
    }
    state.payload.creatives = state.payload.creatives.map((creative) => ({
      ...creative,
      media: data.creatives[creative.creativeId] || [],
    }));
    state.payload.dataHealth = data.dataHealth;
    state.payload.warnings = [
      ...new Set([...(state.payload.warnings || []), ...(data.warnings || [])]),
    ];
    if (state.detail) {
      const updated = state.payload.creatives.find(
        (creative) => creative.creativeId === state.detail.row.creativeId,
      );
      if (updated) {
        state.detail.row = updated;
        state.detail.selectedAdId ??= updated.media[0]?.adId ?? null;
      }
    }
    renderDataHealth();
    render();
    if (state.analysis) renderAnalysis();
    if (state.detail) renderDetail();
    warning.textContent = state.payload.warnings.join(" ");
    warning.classList.toggle("hidden", !state.payload.warnings.length);
  } catch (error) {
    if (requestId !== state.mediaRequest) return;
    warning.textContent =
      `${warning.textContent || ""} Preview enrichment unavailable: ${error.message}`.trim();
    warning.classList.remove("hidden");
  } finally {
    if (requestId === state.mediaRequest) $("mediaType").disabled = false;
  }
}

async function loadData(force = false) {
  if (state.loading) return;
  state.loading = true;
  loading.classList.remove("hidden");
  grid.innerHTML = "";
  warning.classList.add("hidden");
  $("mediaType").disabled = true;
  resetSlices();
  try {
    const params = currentRangeParams(force);
    const response = await fetch(`/api/creatives?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load creatives");
    state.payload = data;
    renderSummary();
    renderDataHealth();
    render();
    $("freshness").textContent = `${data.range.since} → ${data.range.until} · ${data.source} · ${data.adjustApp || "Adjust"}`;
    if (data.warnings?.length) {
      warning.textContent = data.warnings.join(" ");
      warning.classList.remove("hidden");
    }
    void loadMedia(params);
    const initialQuery = new URLSearchParams(window.location.search);
    const initialSlice = Object.entries(sliceControls).find(
      ([, config]) => initialQuery.get(config.parameter),
    );
    if (initialSlice) void loadSlice(initialSlice[0], params);
    if (!state.initialDetailApplied) {
      state.initialDetailApplied = true;
      const creativeId = new URLSearchParams(window.location.search).get(
        "creative",
      );
      if (creativeId) void openDetail(creativeId);
    }
    if (state.page === "analysis") {
      void loadAnalysis();
      void loadVideoMetrics(params);
    }
  } catch (error) {
    warning.textContent = error.message;
    warning.classList.remove("hidden");
    grid.innerHTML = '<div class="empty-state">Could not load dashboard data.</div>';
    $("mediaType").disabled = false;
  } finally {
    state.loading = false;
    loading.classList.add("hidden");
  }
}

function analysisMap() {
  return new Map(
    (state.analysis?.records || [])
      .filter((record) => record.status === "scanned" && record.analysis)
      .map((record) => [record.creativeId, record.analysis]),
  );
}

function creativeScore(row) {
  const spend = Math.min(1, Math.log10(Math.max(row.metaSpend, 1)) / 5);
  const cpi = row.cpi > 0 ? Math.max(0, Math.min(1, (35 - row.cpi) / 25)) : 0;
  const cvr = Math.max(0, Math.min(1, row.cvr / 10));
  const d7 =
    row.adjustRetentionDenD7 > 0
      ? Math.max(0, Math.min(1, row.adjustRetentionD7 / 20))
      : 0.5;
  return spend * 0.2 + cpi * 0.3 + cvr * 0.25 + d7 * 0.25;
}

function analysisCreativeRow(row, analysis, mode) {
  const thumb = safeUrl(row.media[0]?.thumbnailUrl);
  const note =
    mode === "working"
      ? analysis?.strengths?.[0] || analysis?.summary || "Strong blended performance."
      : analysis?.risks?.[0] || analysis?.summary || "High cost or weak conversion signal.";
  const metric =
    mode === "working"
      ? `<strong>${money(row.cpi)}</strong><span>CPI · ${retentionPct(row.adjustRetentionD7, row.adjustRetentionDenD7)} D7</span>`
      : `<strong>${money(row.metaSpend, true)}</strong><span>${money(row.cpi)} CPI</span>`;
  return `
    <div class="analysis-creative" data-analysis-creative="${escapeHtml(row.creativeId)}">
      ${thumb ? `<img src="${escapeHtml(thumb)}" alt="" />` : "<div></div>"}
      <div><div class="analysis-creative-name">${escapeHtml(row.creativeName)}</div><div class="analysis-creative-note">${escapeHtml(note)}</div></div>
      <div class="analysis-creative-metric">${metric}</div>
    </div>`;
}

function addGroupedPerformance(current, row) {
  current.spend += row.metaSpend;
  current.installs += row.adjustInstalls;
  current.retainedD1 += row.adjustRetainedD1;
  current.retentionDenD1 += row.adjustRetentionDenD1;
  current.retainedD3 += row.adjustRetainedD3;
  current.retentionDenD3 += row.adjustRetentionDenD3;
  current.count += 1;
}

function groupedRetention(value, day) {
  const retained = value[`retainedD${day}`];
  const denominator = value[`retentionDenD${day}`];
  if (!denominator) return { rate: "—", sample: "no mature cohort" };
  return {
    rate: pct((retained / denominator) * 100),
    sample: `${integer(retained)}/${integer(denominator)} retained`,
  };
}

function groupedPerformanceRow(name, value, maxSpend) {
  const d1 = groupedRetention(value, 1);
  const d3 = groupedRetention(value, 3);
  const cpi = value.installs > 0 ? money(value.spend / value.installs) : "—";
  return `
    <div class="concept-row">
      <div class="concept-row-main">
        <span>${escapeHtml(name)}</span>
        <div class="concept-bar"><i style="width:${(value.spend / maxSpend) * 100}%"></i></div>
        <strong>${money(value.spend, true)}</strong>
      </div>
      <div class="concept-performance">
        <span title="${integer(value.installs)} installs">CPI <strong>${cpi}</strong></span>
        <span title="${escapeHtml(d1.sample)}">D1 <strong>${d1.rate}</strong></span>
        <span title="${escapeHtml(d3.sample)}">D3 <strong>${d3.rate}</strong></span>
      </div>
    </div>`;
}

function conceptBreakdown(scannedRows, analyses) {
  const dimensions = [
    ["theme", "Theme"],
    ["angle", "Angle"],
    ["format", "Format"],
    ["presenter", "Presenter"],
    ["awareness", "Awareness"],
    ["mediaType", "Media type"],
  ];
  return `<div class="concept-dimensions">${dimensions
    .map(([key, label]) => {
      const groups = new Map();
      for (const row of scannedRows) {
        const value = analyses.get(row.creativeId)?.taxonomy?.[key] || "other";
        const current = groups.get(value) || {
          spend: 0,
          installs: 0,
          retainedD1: 0,
          retentionDenD1: 0,
          retainedD3: 0,
          retentionDenD3: 0,
          count: 0,
        };
        addGroupedPerformance(current, row);
        groups.set(value, current);
      }
      const sorted = [...groups.entries()]
        .sort((a, b) => b[1].spend - a[1].spend)
        .slice(0, 6);
      const max = Math.max(...sorted.map(([, value]) => value.spend), 1);
      return `<div class="concept-dimension"><h4>${label}</h4>${sorted
        .map(([name, value]) => groupedPerformanceRow(name, value, max))
        .join("")}</div>`;
    })
    .join("")}</div>`;
}

function colorTheoryBreakdown(scannedRows, analyses) {
  const dimensions = [
    ["paletteTemperature", "Temperature"],
    ["harmony", "Harmony"],
    ["contrast", "Contrast"],
    ["saturation", "Saturation"],
    ["brightness", "Brightness"],
    ["textLegibility", "Text legibility"],
  ];
  return `<div class="concept-dimensions">${dimensions
    .map(([key, label]) => {
      const groups = new Map();
      for (const row of scannedRows) {
        const value = analyses.get(row.creativeId)?.colorTheory?.[key] || "unscanned";
        const current = groups.get(value) || {
          spend: 0,
          installs: 0,
          retainedD1: 0,
          retentionDenD1: 0,
          retainedD3: 0,
          retentionDenD3: 0,
          count: 0,
        };
        addGroupedPerformance(current, row);
        groups.set(value, current);
      }
      const sorted = [...groups.entries()].sort(
        (a, b) => b[1].spend - a[1].spend,
      );
      const max = Math.max(...sorted.map(([, value]) => value.spend), 1);
      return `<div class="concept-dimension"><h4>${label}</h4>${sorted
        .map(([name, value]) => groupedPerformanceRow(name, value, max))
        .join("")}</div>`;
    })
    .join("")}</div>`;
}

function analysisValue(analysis, key) {
  if (key.startsWith("colorTheory.")) {
    return analysis?.colorTheory?.[key.split(".")[1]];
  }
  if (key.startsWith("composition.")) {
    return analysis?.composition?.[key.split(".")[1]];
  }
  return analysis?.taxonomy?.[key];
}

function weightedMode(rows, analyses, key) {
  const values = new Map();
  for (const row of rows) {
    const value = analysisValue(analyses.get(row.creativeId), key);
    if (!value) continue;
    const current = values.get(value) || { spend: 0, count: 0 };
    current.spend += row.metaSpend;
    current.count += 1;
    values.set(value, current);
  }
  return [...values.entries()].sort((a, b) => b[1].spend - a[1].spend)[0] || [
    "not enough scans",
    { spend: 0, count: 0 },
  ];
}

function winnerRecipe(scannedRows, analyses) {
  const winners = [...scannedRows]
    .filter((row) => row.metaSpend >= 1000)
    .sort((a, b) => creativeScore(b) - creativeScore(a))
    .slice(0, Math.max(3, Math.ceil(scannedRows.length * 0.25)));
  const dimensions = [
    ["theme", "Main theme"],
    ["angle", "Winning angle"],
    ["format", "Format"],
    ["presenter", "Presenter"],
    ["hookType", "Opening hook"],
    ["awareness", "Awareness"],
    ["feeling", "Feeling"],
    ["colorTheory.harmony", "Color harmony"],
    ["colorTheory.contrast", "Contrast"],
    ["colorTheory.paletteTemperature", "Palette"],
  ];
  const recipe = dimensions.map(([key, label]) => {
    const [value, evidence] = weightedMode(winners, analyses, key);
    return { key, label, value, evidence };
  });
  return {
    winners,
    recipe,
    html: `<div class="recipe-grid">${recipe
      .map(
        (item) => `<div class="recipe-step"><span>${item.label}</span><strong>${escapeHtml(item.value)}</strong><p>${item.evidence.count} winner${item.evidence.count === 1 ? "" : "s"} · ${money(item.evidence.spend, true)} spend</p></div>`,
      )
      .join("")}</div>`,
  };
}

function renderCompetitors() {
  const payload = state.competitors;
  if (!payload) return;
  const selected = $("competitorBrand").value;
  const creatives = payload.creatives
    .filter((creative) => selected === "all" || creative.brand === selected)
    .slice(0, 40);
  $("competitorDisclosure").textContent =
    `${payload.disclosure} · Updated ${new Date(payload.generatedAt).toLocaleString()}` +
    (payload.errors?.length ? ` · ${payload.errors.length} source errors` : "");
  $("inspirationQueries").innerHTML =
    creatives
      .map((creative, index) => {
        const media = creative.media?.[0];
        const mediaUrl = safeUrl(media?.url);
        const thumbnail = safeUrl(media?.thumbnailUrl || media?.url);
        const mediaMarkup =
          media?.type === "video" && mediaUrl
            ? `<video controls muted preload="metadata" ${thumbnail ? `poster="${escapeHtml(thumbnail)}"` : ""}><source src="${escapeHtml(mediaUrl)}" /></video>`
            : thumbnail
              ? `<img src="${escapeHtml(thumbnail)}" alt="" loading="lazy" />`
              : '<div class="media-empty">No public preview</div>';
        return `
          <article class="inspiration-query competitor-card">
            <div class="competitor-rank">#${index + 1}</div>
            <div class="competitor-media">${mediaMarkup}</div>
            <div class="competitor-body">
              <div><span>${escapeHtml(creative.brand)}</span><strong>${compact(creative.reportedViews)} views</strong></div>
              <h3>${escapeHtml(creative.pageName)}</h3>
              <p>${escapeHtml(creative.headline || creative.body || "No public copy")}</p>
              <div class="competitor-meta">${escapeHtml(creative.displayFormat)} · ${escapeHtml((creative.platforms || []).join(", "))}</div>
              <div class="competitor-actions"><a href="${escapeHtml(creative.libraryUrl)}" target="_blank" rel="noreferrer">Open in Meta Ad Library ↗</a><button data-create-brief="${index}">Create test brief</button></div>
            </div>
          </article>`;
      })
      .join("") ||
    '<div class="analysis-empty">No official active creatives with reported GB views for this brand.</div>';
  $("inspirationQueries").querySelectorAll("[data-create-brief]").forEach(
    (button) => {
      button.addEventListener("click", () =>
        void createCompetitorBrief(creatives[Number(button.dataset.createBrief)]),
      );
    },
  );
}

async function createCompetitorBrief(creative) {
  if (!creative) return;
  const title = `${creative.brand} inspiration · ${creative.headline || creative.pageName}`;
  const response = await fetch("/api/test-briefs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      sourceBrand: creative.brand,
      sourceCreative: creative.libraryUrl,
      hypothesis: `Adapt the ${creative.displayFormat || "creative"} pattern for a Gist value proposition.`,
      valueProposition: "",
      audience: "",
      variants:
        "1. Direct adaptation\\n2. New hook with same structure\\n3. Gist-native creator version",
      status: "Draft",
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not create brief");
  await loadWorkspace();
  $("workspaceDialog").showModal();
}

async function loadCompetitors(force = false) {
  $("competitorDisclosure").textContent =
    "Loading public competitor creatives…";
  try {
    const response = await fetch(
      `/api/competitors${force ? "?refresh=1" : ""}`,
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Competitor feed unavailable");
    state.competitors = data;
    const select = $("competitorBrand");
    const previous = select.value;
    select.replaceChildren();
    appendOption(select, "all", "All adjacent brands");
    for (const brand of data.brands || []) {
      appendOption(select, brand, brand);
    }
    if ([...select.options].some((option) => option.value === previous)) {
      select.value = previous;
    }
    renderCompetitors();
  } catch (error) {
    $("competitorDisclosure").textContent = error.message;
    $("inspirationQueries").innerHTML =
      '<div class="analysis-empty">Competitor feed unavailable.</div>';
  }
}

function detailedDataTable(rows, analyses) {
  const headers = [
    "Creative",
    "Spend",
    "Impr.",
    "Clicks",
    "Installs",
    "CPM",
    "CTR",
    "CPC",
    "CVR",
    "CPI",
    "D1",
    "D1 retained",
    "D1 mature N",
    "D3",
    "D3 retained",
    "D3 mature N",
    "D7",
    "D7 retained",
    "D7 mature N",
    "Starts",
    "3s views",
    "Hook",
    "ThruPlay",
    "Hold",
    "25%",
    "50%",
    "75%",
    "100%",
    "Avg watch",
    "Theme",
    "Angle",
    "Format",
    "Palette",
    "Harmony",
    "Contrast",
    "Scan",
  ];
  const body = rows
    .map((row) => {
      const video = state.videoMetrics?.creatives?.[row.creativeId] || {};
      const analysis = analyses.get(row.creativeId);
      const values = [
        row.creativeName,
        money(row.metaSpend),
        integer(row.metaImpressions),
        integer(row.metaClicks),
        integer(row.adjustInstalls),
        money(row.metaCpm),
        pct(row.metaCtr),
        money(row.metaCpc),
        pct(row.cvr),
        money(row.cpi),
        retentionPct(row.adjustRetentionD1, row.adjustRetentionDenD1),
        integer(row.adjustRetainedD1),
        integer(row.adjustRetentionDenD1),
        retentionPct(row.adjustRetentionD3, row.adjustRetentionDenD3),
        integer(row.adjustRetainedD3),
        integer(row.adjustRetentionDenD3),
        retentionPct(row.adjustRetentionD7, row.adjustRetentionDenD7),
        integer(row.adjustRetainedD7),
        integer(row.adjustRetentionDenD7),
        integer(video.videoStarts),
        integer(video.threeSecondViews),
        pct(video.hookRate),
        integer(video.thruPlays),
        pct(video.holdRate),
        pct(video.p25Rate),
        pct(video.p50Rate),
        pct(video.p75Rate),
        pct(video.completionRate),
        `${Number(video.avgWatchSeconds || 0).toFixed(1)}s`,
        analysis?.taxonomy?.theme || "—",
        analysis?.taxonomy?.angle || "—",
        analysis?.taxonomy?.format || "—",
        analysis?.colorTheory?.paletteTemperature || "—",
        analysis?.colorTheory?.harmony || "—",
        analysis?.colorTheory?.contrast || "—",
        analysis ? "Scanned" : "Unscanned",
      ];
      return `<tr data-analysis-creative="${escapeHtml(row.creativeId)}">${values
        .map(
          (value, index) =>
            `<td class="${index === 0 ? "sticky-cell" : ""}">${escapeHtml(value)}</td>`,
        )
        .join("")}</tr>`;
    })
    .join("");
  return `<table class="analysis-data-table"><thead><tr>${headers
    .map((header, index) => `<th class="${index === 0 ? "sticky-cell" : ""}">${header}</th>`)
    .join("")}</tr></thead><tbody>${body}</tbody></table>`;
}

function reportCard(row, metrics) {
  const thumb = safeUrl(row.media[0]?.thumbnailUrl);
  return `
    <article class="report-card" data-analysis-creative="${escapeHtml(row.creativeId)}">
      <div class="report-card-media">${thumb ? `<img src="${escapeHtml(thumb)}" alt="" />` : ""}</div>
      <div class="report-card-body">
        <h4>${escapeHtml(row.creativeName)}</h4>
        <div class="report-metrics">${metrics
          .map(
            ([label, value]) =>
              `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`,
          )
          .join("")}</div>
      </div>
    </article>`;
}

function attachReportCardClicks() {
  $("analysisReportView")
    .querySelectorAll("[data-analysis-creative]")
    .forEach((item) => {
      item.addEventListener("click", () =>
        void openDetail(item.dataset.analysisCreative),
      );
    });
}

function reportHeader(title, description) {
  return `<div class="report-heading"><div><h3>${title}</h3><p>${description}</p></div><span>${state.payload?.range.since} → ${state.payload?.range.until}</span></div>`;
}

function renderHooksReport(rows) {
  const ranked = rows
    .map((row) => ({
      row,
      video: state.videoMetrics?.creatives?.[row.creativeId],
    }))
    .filter(({ video }) => video?.threeSecondViews >= 100)
    .sort(
      (a, b) =>
        b.video.hookRate - a.video.hookRate ||
        b.video.threeSecondViews - a.video.threeSecondViews,
    )
    .slice(0, 30);
  return (
    reportHeader(
      "Top Hooks",
      "Ranked by Meta 3-second views / impressions; minimum 100 three-second views.",
    ) +
    `<div class="report-grid">${ranked
      .map(({ row, video }) =>
        reportCard(row, [
          ["Hook rate", pct(video.hookRate)],
          ["Hold rate", pct(video.holdRate)],
          ["3s views", compact(video.threeSecondViews)],
          ["ThruPlays", compact(video.thruPlays)],
          ["Completion", pct(video.completionRate)],
          ["Spend", money(row.metaSpend, true)],
        ]),
      )
      .join("")}</div>`
  );
}

function renderClicksReport(rows) {
  const ranked = [...rows]
    .filter((row) => row.metaImpressions > 0)
    .sort(
      (a, b) =>
        b.metaCtr - a.metaCtr ||
        a.metaCpc - b.metaCpc ||
        a.metaCpm - b.metaCpm,
    )
    .slice(0, 100);
  return (
    reportHeader(
      "Top Clicks",
      "Creative click efficiency compared using Meta CTR, CPC, and CPM.",
    ) +
    `<div class="data-table-wrap"><table class="analysis-data-table efficiency-table">
      <thead><tr><th class="sticky-cell">Creative</th><th>CTR</th><th>CPC</th><th>CPM</th></tr></thead>
      <tbody>${ranked
        .map(
          (row) => `<tr data-analysis-creative="${escapeHtml(row.creativeId)}">
            <td class="sticky-cell">${escapeHtml(row.creativeName)}</td>
            <td>${escapeHtml(pct(row.metaCtr))}</td>
            <td>${escapeHtml(money(row.metaCpc))}</td>
            <td>${escapeHtml(money(row.metaCpm))}</td>
          </tr>`,
        )
        .join("")}</tbody>
    </table></div>`
  );
}

function renderCopyReport(rows, analyses) {
  const seen = new Set();
  const ranked = rows
    .flatMap((row) =>
      row.media
        .filter((media) => media.primaryText || media.headline || media.description)
        .map((media) => ({
          row,
          media,
          analysis: analyses.get(row.creativeId),
        })),
    )
    .sort(
      (a, b) =>
        b.row.metaCtr - a.row.metaCtr ||
        b.row.metaSpend - a.row.metaSpend,
    )
    .filter(({ media }) => {
      const key = [
        media.headline,
        media.primaryText,
        media.description,
      ].join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 100);
  return (
    reportHeader(
      "Top Copy",
      "Meta headlines, primary text, descriptions, and calls to action ranked by creative CTR.",
    ) +
    `<div class="data-table-wrap copy-table-wrap"><table class="analysis-data-table copy-table">
      <thead><tr>
        <th class="sticky-cell">Creative</th>
        <th>Headline</th>
        <th>Primary text</th>
        <th>Description</th>
        <th>CTA</th>
        <th>CTR</th>
        <th>CPC</th>
      </tr></thead>
      <tbody>${ranked
        .map(
          ({ row, media, analysis }) => `<tr data-analysis-creative="${escapeHtml(row.creativeId)}">
            <td class="sticky-cell">${escapeHtml(row.creativeName)}</td>
            <td>${escapeHtml(media.headline || "—")}</td>
            <td>${escapeHtml(media.primaryText || "—")}</td>
            <td>${escapeHtml(media.description || "—")}</td>
            <td>${escapeHtml(analysis?.cta || media.callToActionType || "—")}</td>
            <td>${escapeHtml(pct(row.metaCtr))}</td>
            <td>${escapeHtml(money(row.metaCpc))}</td>
          </tr>`,
        )
        .join("")}</tbody>
    </table></div>`
  );
}

function retentionConfig(day) {
  return {
    day,
    rate: `adjustRetentionD${day}`,
    numerator: `adjustRetainedD${day}`,
    denominator: `adjustRetentionDenD${day}`,
  };
}

function retentionLeaders(rows, limit = 10) {
  const d1 = retentionConfig(1);
  const d3 = retentionConfig(3);
  const d7 = retentionConfig(7);
  return rows
    .filter(
      (row) =>
        row.metaSpend > 0 &&
        !row.creativeName.includes("{{") &&
        Number(row[d7.denominator] || 0) >= 50,
    )
    .sort(
      (a, b) =>
        Number(b[d7.rate] || 0) - Number(a[d7.rate] || 0) ||
        Number(b[d3.rate] || 0) - Number(a[d3.rate] || 0) ||
        Number(b[d1.rate] || 0) - Number(a[d1.rate] || 0) ||
        Number(b[d7.denominator] || 0) - Number(a[d7.denominator] || 0),
    )
    .slice(0, limit);
}

function retentionTableCell(row, day) {
  const config = retentionConfig(day);
  return `<td class="retention-period">
    <strong>${retentionPct(row[config.rate], row[config.denominator])}</strong>
    <small>${integer(row[config.numerator])}/${integer(row[config.denominator])}</small>
  </td>`;
}

function retentionLeadersTable(rows, limit = 10) {
  const leaders = retentionLeaders(rows, limit);
  if (!leaders.length) {
    return '<div class="analysis-empty">No creative has at least 50 mature D7 installs in this window. Choose a longer date range.</div>';
  }
  return `
    <table class="analysis-data-table retention-combined-table">
      <thead><tr><th>#</th><th class="sticky-cell">Creative</th><th>Spend</th><th>CPI</th><th>D1</th><th>D3</th><th>D7</th></tr></thead>
      <tbody>${leaders
        .map((row, index) => {
          const thumb = safeUrl(row.media[0]?.thumbnailUrl);
          return `<tr data-analysis-creative="${escapeHtml(row.creativeId)}">
            <td class="retention-rank">${index + 1}</td>
            <td class="sticky-cell retention-creative">
              <div>
                ${thumb ? `<img src="${escapeHtml(thumb)}" alt="" />` : '<span class="retention-thumb-empty"></span>'}
                <strong>${escapeHtml(row.creativeName)}</strong>
              </div>
            </td>
            <td>${money(row.metaSpend, true)}</td>
            <td>${money(row.cpi)}</td>
            ${retentionTableCell(row, 1)}
            ${retentionTableCell(row, 3)}
            ${retentionTableCell(row, 7)}
          </tr>`;
        })
        .join("")}</tbody>
    </table>`;
}

function renderRetentionReport(rows) {
  return (
    reportHeader(
      "Retention Leaders",
      "Top 10 ranked by D7 retention; D1/D3/D7 use mature Adjust calendar cohorts and show retained/mature counts.",
    ) +
    `<div class="data-table-wrap retention-table-wrap">${retentionLeadersTable(rows, 10)}</div>`
  );
}

function renderLandingReport(rows) {
  const groups = new Map();
  for (const row of rows) {
    const urls = [
      ...new Set(
        row.media.map((item) => item.destinationUrl).filter(Boolean),
      ),
    ];
    const url = urls[0] || "(destination unavailable)";
    const video = state.videoMetrics?.creatives?.[row.creativeId] || {};
    const group = groups.get(url) || {
      url,
      spend: 0,
      linkClicks: 0,
      landingPageViews: 0,
      leads: 0,
      purchases: 0,
      purchaseValue: 0,
      creatives: 0,
    };
    group.spend += row.metaSpend;
    group.linkClicks += video.linkClicks || 0;
    group.landingPageViews += video.landingPageViews || 0;
    group.leads += video.leads || 0;
    group.purchases += video.purchases || 0;
    group.purchaseValue += video.purchaseValue || 0;
    group.creatives += 1;
    groups.set(url, group);
  }
  const ranked = [...groups.values()]
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 40);
  return (
    reportHeader(
      "Landing Pages",
      "Group-level Meta destination URLs with raw link clicks, landing-page views, leads, purchases, and values.",
    ) +
    `<div class="data-table-wrap"><table class="analysis-data-table"><thead><tr>${[
      "Destination",
      "Creatives",
      "Spend",
      "Link clicks",
      "LPV",
      "Click→LPV",
      "Cost / LPV",
      "Leads",
      "Purchases",
      "Purchase rate",
      "Purchase value",
      "ROAS",
    ]
      .map((header, index) => `<th class="${index === 0 ? "sticky-cell" : ""}">${header}</th>`)
      .join("")}</tr></thead><tbody>${ranked
      .map((group) => {
        const clickToLpv = group.linkClicks
          ? (group.landingPageViews / group.linkClicks) * 100
          : 0;
        const costLpv = group.landingPageViews
          ? group.spend / group.landingPageViews
          : 0;
        const purchaseRate = group.landingPageViews
          ? (group.purchases / group.landingPageViews) * 100
          : 0;
        const roas = group.spend ? group.purchaseValue / group.spend : 0;
        const values = [
          group.url,
          group.creatives,
          money(group.spend),
          integer(group.linkClicks),
          integer(group.landingPageViews),
          pct(clickToLpv),
          money(costLpv),
          integer(group.leads),
          integer(group.purchases),
          pct(purchaseRate),
          money(group.purchaseValue),
          `${roas.toFixed(2)}×`,
        ];
        return `<tr>${values
          .map(
            (value, index) =>
              `<td class="${index === 0 ? "sticky-cell" : ""}">${escapeHtml(value)}</td>`,
          )
          .join("")}</tr>`;
      })
      .join("")}</tbody></table></div>`
  );
}

function renderAnalysisReport() {
  if (!state.payload || !state.analysis) return;
  const report = state.analysisReport;
  const rows = state.payload.creatives;
  const analyses = analysisMap();
  $("analysisOverview").classList.toggle("hidden", report !== "overview");
  $("analysisReportView").classList.toggle("hidden", report === "overview");
  document.querySelectorAll("[data-analysis-report]").forEach((button) => {
    button.classList.toggle("active", button.dataset.analysisReport === report);
  });
  if (report === "overview") return;
  const renderers = {
    hooks: () => renderHooksReport(rows),
    clicks: () => renderClicksReport(rows),
    copy: () => renderCopyReport(rows, analyses),
    retention: () => renderRetentionReport(rows),
    landing: () => renderLandingReport(rows),
    data: () =>
      reportHeader(
        "Detailed Data Views",
        "Every retained delivery, attribution, retention, video, concept, and color field.",
      ) + `<div class="data-table-wrap">${detailedDataTable(rows, analyses)}</div>`,
  };
  $("analysisReportView").innerHTML =
    renderers[report]?.() || '<div class="analysis-empty">Report unavailable.</div>';
  attachReportCardClicks();
}

function setAnalysisReport(report) {
  state.analysisReport = report;
  renderAnalysisReport();
}

function accountVideoPanel() {
  const totals = state.videoMetrics?.totals;
  if (!totals) {
    return '<div class="analysis-empty">Loading Meta video metrics…</div>';
  }
  return videoFunnelMarkup(totals);
}

function renderAnalysis() {
  if (!state.payload || !state.analysis) return;
  const analyses = analysisMap();
  const scannedRows = state.payload.creatives.filter((row) =>
    analyses.has(row.creativeId),
  );
  const coverage = state.analysis.coverage;
  $("analysisCoverage").textContent =
    `${coverage.scanned} of ${coverage.total} creatives scanned` +
    (coverage.stale ? ` · ${coverage.stale} stale` : "") +
    ` · ${state.analysis.model}` +
    (state.analysis.schedule?.enabled && state.analysis.schedule.nextRunAt
      ? ` · next daily scan ${new Date(state.analysis.schedule.nextRunAt).toLocaleString()} (cap ${integer(state.analysis.schedule.dailyLimit)})`
      : "");

  const all = state.payload.creatives;
  const top3Spend = all.slice(0, 3).reduce((sum, row) => sum + row.metaSpend, 0);
  const totalSpend = state.payload.totals.spend || 1;
  const hookRate = state.videoMetrics?.totals?.hookRate;
  const health = all.length
    ? Math.round(
        (all
          .filter((row) => row.metaSpend >= 1000)
          .slice(0, 20)
          .reduce((sum, row) => sum + creativeScore(row), 0) /
          Math.max(
            1,
            all.filter((row) => row.metaSpend >= 1000).slice(0, 20).length,
          )) *
          100,
      )
    : 0;
  $("analysisSummary").innerHTML = `
    <div class="analysis-kpi primary"><span>Creative health</span><strong>${health}/100</strong><p>Performance blend, not a business KPI</p></div>
    <div class="analysis-kpi"><span>Account spend</span><strong>${money(state.payload.totals.spend, true)}</strong><p>${state.payload.range.since} → ${state.payload.range.until}</p></div>
    <div class="analysis-kpi"><span>Meta hook rate</span><strong>${hookRate == null ? "—" : pct(hookRate)}</strong><p>3-second views / impressions</p></div>
    <div class="analysis-kpi"><span>Top 3 concentration</span><strong>${((top3Spend / totalSpend) * 100).toFixed(0)}%</strong><p>Share of account spend</p></div>`;

  const working = [...all]
    .filter((row) => row.metaSpend >= 1000)
    .sort((a, b) => creativeScore(b) - creativeScore(a))
    .slice(0, 5);
  const watch = [...all]
    .filter((row) => row.metaSpend >= 1000)
    .sort(
      (a, b) =>
        (b.cpi || 0) - (a.cpi || 0) ||
        b.metaSpend - a.metaSpend,
    )
    .slice(0, 5);
  $("workingCreatives").innerHTML = working
    .map((row) => analysisCreativeRow(row, analyses.get(row.creativeId), "working"))
    .join("");
  $("watchCreatives").innerHTML = watch
    .map((row) => analysisCreativeRow(row, analyses.get(row.creativeId), "watch"))
    .join("");
  $("retentionLeadersOverview").innerHTML = retentionLeadersTable(all, 10);

  if (scannedRows.length) {
    $("conceptBreakdown").innerHTML = conceptBreakdown(scannedRows, analyses);
    $("colorTheoryBreakdown").innerHTML = colorTheoryBreakdown(
      scannedRows,
      analyses,
    );
    const recipe = winnerRecipe(scannedRows, analyses);
    $("winnerRecipe").innerHTML = recipe.html;
  } else {
    const empty =
      '<div class="analysis-empty">Scan creatives to classify themes, angles, formats, hooks, presenters, awareness, and feelings.</div>';
    $("conceptBreakdown").innerHTML = empty;
    $("colorTheoryBreakdown").innerHTML = empty;
    $("winnerRecipe").innerHTML = empty;
  }
  $("videoFunnel").innerHTML = accountVideoPanel();
  $("detailedDataView").innerHTML = detailedDataTable(all, analyses);

  document
    .querySelectorAll("[data-analysis-creative]")
    .forEach((item) => {
    item.addEventListener("click", () =>
      void openDetail(item.dataset.analysisCreative),
    );
    });
  renderAnalysisReport();
}

async function loadAnalysis() {
  if (!state.payload) return;
  try {
    const response = await fetch(`/api/analysis?${currentRangeParams()}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Analysis unavailable");
    state.analysis = data;
    renderAnalysis();
  } catch (error) {
    $("analysisCoverage").textContent = error.message;
  }
}

async function loadVideoMetrics(params = currentRangeParams()) {
  try {
    const response = await fetch(`/api/video-metrics?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Video metrics unavailable");
    state.videoMetrics = data;
    if (state.analysis) renderAnalysis();
    if (state.detail?.tab === "performance") renderDetail();
  } catch (error) {
    console.warn(error.message);
  }
}

const debriefDay = (value) =>
  value
    ? new Date(`${value}T00:00:00Z`).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      })
    : "—";
const debriefShortDay = (value) =>
  value
    ? new Date(`${value}T00:00:00Z`).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      })
    : "—";
const debriefMoney = (value) => (value == null ? "—" : money(value));
const debriefPct = (value) => (value == null ? "—" : pct(value));
const debriefRetentionCost = (row, day, stage = "testing") =>
  debriefMoney(row[stage]?.[`costPerRetainedD${day}`]);
const debriefStageRetention = (row, day, stage = "testing") => {
  const metrics = row[stage];
  if (!metrics || metrics[`d${day}`] == null) return "—";
  return `${debriefPct(metrics[`d${day}`])}<small>${integer(metrics[`retainedD${day}`])}/${integer(metrics[`d${day}Cohort`])}</small>`;
};
const debriefConfidenceChip = (confidence) =>
  confidence
    ? `<span class="debrief-chip confidence-${confidence.toLowerCase()}">${escapeHtml(confidence)} confidence</span>`
    : '<span class="debrief-chip confidence-none">No mature cohort</span>';

function debriefChips(row) {
  const chips = [
    `<span class="debrief-chip ${row.status === "Live" ? "live" : "paused"}">${row.status}</span>`,
    '<span class="debrief-chip testing">Testing</span>',
  ];
  if (row.promoted) chips.push('<span class="debrief-chip scaled">Scaled</span>');
  if (row.carryover) {
    chips.push(
      `<span class="debrief-chip carryover" title="Uploaded ${escapeHtml(row.uploadedDate)}, before this window">Pre-window</span>`,
    );
  }
  return chips.join("");
}

function debriefVerdictChip(row) {
  return `<span class="debrief-chip verdict-${row.verdict.toLowerCase()}">${escapeHtml(row.verdict)}</span>`;
}

function debriefCreativeCell(row) {
  const thumb = safeUrl(row.thumbnailUrl);
  const adId = row.adIds?.[0];
  const preview =
    thumb && adId
      ? `<button class="debrief-preview-button" data-debrief-preview="${escapeHtml(adId)}" data-debrief-creative="${escapeHtml(row.name)}" data-debrief-name="${escapeHtml(row.readableName)}" data-debrief-thumbnail="${escapeHtml(thumb)}" aria-label="Open details for ${escapeHtml(row.readableName)}"><img loading="lazy" src="${escapeHtml(thumb)}" alt="" /></button>`
      : thumb
        ? `<img loading="lazy" src="${escapeHtml(thumb)}" alt="" />`
        : '<span class="debrief-thumb-empty"></span>';
  return `<td class="sticky-cell debrief-creative">
    <div>
      ${preview}
      <div>
        <strong title="${escapeHtml(row.name)}">${escapeHtml(row.readableName)}</strong>
        <small title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</small>
        <span class="debrief-chips">${debriefChips(row)}</span>
      </div>
    </div>
  </td>`;
}

function debriefSpendCells(row) {
  return `<td>${money(row.spend)}</td>
    <td>${money(row.testingSpend)}</td>
    <td>${row.scaledSpend > 0 ? money(row.scaledSpend) : "—"}</td>`;
}

function debriefRankedTable(
  rows,
  emptyText,
  reasonsForRow = (row) => row.reasons,
) {
  if (!rows.length) {
    return `<div class="analysis-empty">${emptyText}</div>`;
  }
  const headers = [
    "Creative",
    "Source",
    "Format",
    "OS",
    "Stage",
    "Uploaded",
    "Total spend",
    "Testing spend",
    "Scaled spend",
    "Testing sign-ups",
    "Testing cost / sign-up",
    "Testing D1",
    "Cost / D1 retained",
    "Testing D3",
    "Cost / D3 retained",
    "Testing D7",
    "Cost / D7 retained",
    "Confidence",
    "Why",
  ];
  return `<table class="analysis-data-table debrief-table"><thead><tr><th class="debrief-rank">#</th>${headers
    .map((header, index) => `<th class="${index === 0 ? "sticky-cell" : ""}">${header}</th>`)
    .join("")}</tr></thead><tbody>${rows
    .map(
      (row, index) => `<tr>
        <td class="debrief-rank">${index + 1}</td>
        ${debriefCreativeCell(row)}
        <td>${escapeHtml(row.source)}</td>
        <td>${escapeHtml(row.format)}</td>
        <td>${escapeHtml(row.os)}</td>
        <td>${row.promoted ? "Testing + scaled" : "Testing only"}</td>
        <td title="${escapeHtml(row.uploadedAt || "")}">${debriefShortDay(row.uploadedDate)}</td>
        ${debriefSpendCells(row)}
        <td>${integer(row.testing.signups)}</td>
        <td><strong>${debriefMoney(row.testing.cpsu)}</strong></td>
        <td>${debriefStageRetention(row, 1)}</td>
        <td>${debriefRetentionCost(row, 1)}</td>
        <td>${debriefStageRetention(row, 3)}</td>
        <td>${debriefRetentionCost(row, 3)}</td>
        <td>${debriefStageRetention(row, 7)}</td>
        <td>${debriefRetentionCost(row, 7)}</td>
        <td>${debriefConfidenceChip(row.retentionConfidence)}</td>
        <td class="debrief-reasons">${reasonsForRow(row).map((reason) => `<div>${escapeHtml(reason)}</div>`).join("")}</td>
      </tr>`,
    )
    .join("")}</tbody></table>`;
}

function debriefSourceRef(item) {
  if (!item) return "—";
  return `<span title="${escapeHtml(item.name)}">${escapeHtml(item.readableName)}</span> <small>${
    item.retentionCost !== null && item.retentionHorizon
      ? `${money(item.retentionCost)}/${item.retentionHorizon} retained`
      : item.cpsu == null
        ? "no sign-ups"
        : `${money(item.cpsu)}/SU`
  }</small>`;
}

function debriefRetentionRiskReasons(row) {
  const horizon = row.retentionHorizon;
  const key = horizon?.toLowerCase();
  const rate = key ? row.testing[key] : null;
  const baseline = key ? state.debrief?.typical?.[key] : null;
  return [
    `Efficient testing sign-ups: ${debriefMoney(row.testing.cpsu)} vs ${debriefMoney(state.debrief?.typical?.cpsu)} typical`,
    `${horizon || "Retention"}: ${debriefPct(rate)} vs ${debriefPct(baseline)} typical`,
  ];
}

function renderDebriefBenchmarks(benchmarks) {
  const rows = [benchmarks.average, benchmarks.best].filter(Boolean);
  return `<table class="analysis-data-table debrief-table benchmark-table">
    <thead><tr><th class="sticky-cell">Benchmark</th><th>Creative</th><th>Creatives</th><th>Testing cost / sign-up</th><th>Testing D1</th><th>Testing D3</th><th>Testing D7</th></tr></thead>
    <tbody>${rows
      .map(
        (row) => `<tr>
          <td class="sticky-cell"><strong>${escapeHtml(row.label)}</strong></td>
          <td>${escapeHtml(row.creativeName || "All eligible creatives")}</td>
          <td>${integer(row.count)}</td>
          <td><strong>${debriefMoney(row.cpsu)}</strong></td>
          <td>${debriefPct(row.d1)}</td>
          <td>${debriefPct(row.d3)}</td>
          <td>${debriefPct(row.d7)}</td>
        </tr>`,
      )
      .join("")}</tbody>
  </table>`;
}

function renderDebriefSegmentBenchmarks(rows) {
  return `<table class="analysis-data-table debrief-table benchmark-table">
    <thead><tr><th class="sticky-cell">Dimension</th><th>Segment</th><th>Creatives</th><th>Testing cost / sign-up</th><th>Testing D1</th><th>Testing D3</th><th>Testing D7</th></tr></thead>
    <tbody>${rows
      .map(
        (row) => `<tr>
          <td class="sticky-cell"><strong>${escapeHtml(row.dimension)}</strong></td>
          <td>${escapeHtml(row.segment)}</td>
          <td>${integer(row.count)}</td>
          <td><strong>${debriefMoney(row.cpsu)}</strong></td>
          <td>${debriefPct(row.d1)}</td>
          <td>${debriefPct(row.d3)}</td>
          <td>${debriefPct(row.d7)}</td>
        </tr>`,
      )
      .join("")}</tbody>
  </table>`;
}

function renderScaleCandidates(rows) {
  if (!rows.length) {
    return '<div class="analysis-empty">No testing winners are currently waiting to be pushed to a main campaign.</div>';
  }
  return `<table class="analysis-data-table debrief-table scale-candidates-table">
    <thead><tr><th class="sticky-cell">Creative</th><th>Source</th><th>Format</th><th>OS</th><th>Testing spend</th><th>Testing sign-ups</th><th>Testing CPSU</th><th>Testing D1</th><th>Testing D3</th><th>Testing D7</th><th>Confidence</th><th>Why ready</th></tr></thead>
    <tbody>${rows
      .map(
        (row) => `<tr>
          ${debriefCreativeCell(row)}
          <td>${escapeHtml(row.source)}</td>
          <td>${escapeHtml(row.format)}</td>
          <td>${escapeHtml(row.os)}</td>
          <td>${money(row.testing.spend)}</td>
          <td>${integer(row.testing.signups)}</td>
          <td>${debriefMoney(row.testing.cpsu)}</td>
          <td>${debriefStageRetention(row, 1)}</td>
          <td>${debriefStageRetention(row, 3)}</td>
          <td>${debriefStageRetention(row, 7)}</td>
          <td>${debriefConfidenceChip(row.testing.confidence)}</td>
          <td class="debrief-reasons">${escapeHtml(row.actionReason)}</td>
        </tr>`,
      )
      .join("")}</tbody>
  </table>`;
}

function renderDebriefTestedCreatives() {
  if (!state.debrief) return;
  const verdict = $("debriefTestedVerdict").value;
  const sort = $("debriefTestedSort").value;
  const since = state.debrief.range.since;
  const until = state.debrief.range.until;
  const rows = state.debrief.all.filter(
    (row) =>
      row.uploadedDate &&
      row.uploadedDate >= since &&
      row.uploadedDate <= until &&
      (verdict === "all" || row.verdict === verdict),
  );
  const byConcept = new Map();
  for (const row of rows) {
    const concept =
      row.testingAdSets?.[0] || row.category || "Unassigned concept";
    const creatives = byConcept.get(concept) || [];
    creatives.push(row);
    byConcept.set(concept, creatives);
  }
  const groups = [...byConcept.entries()].map(([concept, creatives]) => {
    const sum = (key) =>
      creatives.reduce(
        (total, row) => total + Number(row.testing?.[key] || 0),
        0,
      );
    const retention = (day) => {
      const cohort = sum(`d${day}Cohort`);
      return cohort > 0 ? (sum(`retainedD${day}`) / cohort) * 100 : null;
    };
    const testingSpend = sum("spend");
    const testingSignups = sum("signups");
    const verdictCounts = Object.fromEntries(
      ["Winner", "Loser", "Middle", "Learning"].map((outcome) => [
        outcome,
        creatives.filter((row) => row.verdict === outcome).length,
      ]),
    );
    return {
      concept,
      creatives,
      creativeCount: creatives.length,
      latestUploaded: creatives.reduce(
        (latest, row) =>
          (row.uploadedAt || "") > latest ? row.uploadedAt : latest,
        "",
      ),
      testingSpend,
      testingSignups,
      testingCpsu:
        testingSignups > 0 ? testingSpend / testingSignups : null,
      d1: retention(1),
      d3: retention(3),
      d7: retention(7),
      verdictCounts,
    };
  });
  const numeric = (value, fallback) => (value == null ? fallback : Number(value));
  const comparators = {
    newest: (a, b) =>
      b.latestUploaded.localeCompare(a.latestUploaded) ||
      b.testingSpend - a.testingSpend,
    spendDesc: (a, b) => b.testingSpend - a.testingSpend,
    spendAsc: (a, b) => a.testingSpend - b.testingSpend,
    signupsDesc: (a, b) => b.testingSignups - a.testingSignups,
    signupsAsc: (a, b) => a.testingSignups - b.testingSignups,
    cpsuAsc: (a, b) =>
      numeric(a.testingCpsu, Infinity) -
      numeric(b.testingCpsu, Infinity),
    cpsuDesc: (a, b) =>
      numeric(b.testingCpsu, -Infinity) -
      numeric(a.testingCpsu, -Infinity),
    d1Desc: (a, b) =>
      numeric(b.d1, -Infinity) - numeric(a.d1, -Infinity),
    d3Desc: (a, b) =>
      numeric(b.d3, -Infinity) - numeric(a.d3, -Infinity),
    d7Desc: (a, b) =>
      numeric(b.d7, -Infinity) - numeric(a.d7, -Infinity),
  };
  groups.sort(comparators[sort] || comparators.newest);
  const pageSize = 25;
  const totalPages = Math.max(1, Math.ceil(groups.length / pageSize));
  state.debriefTestedPageNumber = Math.min(
    Math.max(1, state.debriefTestedPageNumber),
    totalPages,
  );
  const start = (state.debriefTestedPageNumber - 1) * pageSize;
  const pageGroups = groups.slice(start, start + pageSize);
  $("debriefTestedCount").textContent = groups.length
    ? `${start + 1}–${Math.min(start + pageSize, groups.length)} of ${groups.length} concepts · ${rows.length} creatives`
    : "No launched creatives";
  $("debriefTestedPageStatus").textContent =
    `Page ${state.debriefTestedPageNumber} of ${totalPages}`;
  $("debriefTestedPreviousPage").disabled =
    state.debriefTestedPageNumber <= 1;
  $("debriefTestedNextPage").disabled =
    state.debriefTestedPageNumber >= totalPages || groups.length === 0;
  const verdictMix = (group) =>
    ["Winner", "Loser", "Middle", "Learning"]
      .filter((outcome) => group.verdictCounts[outcome] > 0)
      .map(
        (outcome) =>
          `<span class="debrief-chip verdict-${outcome.toLowerCase()}">${outcome} ${group.verdictCounts[outcome]}</span>`,
      )
      .join(" ");
  $("debriefTestedCreatives").innerHTML = pageGroups.length
    ? `<table class="analysis-data-table debrief-table tested-creatives-table">
      <thead><tr><th></th><th class="sticky-cell">Concept / ad group</th><th>Creatives</th><th>Verdict mix</th><th>Latest launch</th><th>Source</th><th>Format</th><th>OS</th><th>Testing spend</th><th>Sign-ups</th><th>CPSU</th><th>D1</th><th>D3</th><th>D7</th></tr></thead>
      <tbody>${pageGroups
        .map((group) => {
          const expanded = state.expandedTestedGroups.has(group.concept);
          const groupRow = `<tr class="tested-concept-row" data-tested-concept="${escapeHtml(group.concept)}">
            <td><button class="concept-toggle" aria-label="${expanded ? "Collapse" : "Expand"} ${escapeHtml(group.concept)}">${expanded ? "▾" : "▸"}</button></td>
            <td class="sticky-cell"><strong>${escapeHtml(group.concept)}</strong></td>
            <td>${integer(group.creativeCount)}</td>
            <td class="tested-verdict-mix">${verdictMix(group)}</td>
            <td>${debriefShortDay(group.latestUploaded?.slice(0, 10))}</td>
            <td colspan="3">—</td>
            <td>${money(group.testingSpend)}</td>
            <td>${integer(group.testingSignups)}</td>
            <td>${debriefMoney(group.testingCpsu)}</td>
            <td>${debriefPct(group.d1)}</td>
            <td>${debriefPct(group.d3)}</td>
            <td>${debriefPct(group.d7)}</td>
          </tr>`;
          const childRows = expanded
            ? [...group.creatives]
                .sort(
                  (a, b) =>
                    b.testing.spend - a.testing.spend ||
                    (b.uploadedAt || "").localeCompare(a.uploadedAt || ""),
                )
                .map(
                  (row) => `<tr class="tested-creative-row">
                    <td></td>
                    ${debriefCreativeCell(row)}
                    <td></td>
                    <td>${debriefVerdictChip(row)}</td>
                    <td>${debriefShortDay(row.uploadedDate)}</td>
                    <td>${escapeHtml(row.source)}</td>
                    <td>${escapeHtml(row.format)}</td>
                    <td>${escapeHtml(row.os)}</td>
                    <td>${money(row.testing.spend)}</td>
                    <td>${integer(row.testing.signups)}</td>
                    <td>${debriefMoney(row.testing.cpsu)}</td>
                    <td>${debriefStageRetention(row, 1)}</td>
                    <td>${debriefStageRetention(row, 3)}</td>
                    <td>${debriefStageRetention(row, 7)}</td>
                  </tr>`,
                )
                .join("")
            : "";
          return groupRow + childRows;
        })
        .join("")}</tbody>
    </table>`
    : '<div class="analysis-empty">No creatives were launched in this period with the selected verdict.</div>';
}

function renderDebriefSources(sources) {
  const headers = [
    "Source",
    "Tested",
    "Spend",
    "Testing spend",
    "Scaled spend",
    "Sign-ups",
    "Cost / sign-up",
    "Winners",
    "Losers",
    "Learning",
    "Scaled",
    "Best",
    "Worst",
  ];
  return `<table class="analysis-data-table debrief-table"><thead><tr>${headers
    .map((header, index) => `<th class="${index === 0 ? "sticky-cell" : ""}">${header}</th>`)
    .join("")}</tr></thead><tbody>${sources
    .map(
      (row) => `<tr>
        <td class="sticky-cell"><strong>${escapeHtml(row.source)}</strong></td>
        <td>${integer(row.tested)}</td>
        <td>${money(row.spend, true)}</td>
        <td>${money(row.testingSpend, true)}</td>
        <td>${row.scaledSpend > 0 ? money(row.scaledSpend, true) : "—"}</td>
        <td>${integer(row.signups)}</td>
        <td><strong>${debriefMoney(row.cpsu)}</strong></td>
        <td>${integer(row.winners)}</td>
        <td>${integer(row.losers)}</td>
        <td>${integer(row.learning)}</td>
        <td>${integer(row.promoted)}</td>
        <td class="debrief-ref">${debriefSourceRef(row.best)}</td>
        <td class="debrief-ref">${debriefSourceRef(row.worst)}</td>
      </tr>`,
    )
    .join("")}</tbody></table>`;
}

async function fetchDebriefPreview(adId) {
  const cached = state.debriefPreviewCache.get(adId);
  if (cached) return await cached;
  const pending = fetch(`/api/preview?adId=${encodeURIComponent(adId)}`)
    .then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Preview unavailable");
      const src = safeUrl(data.src);
      if (!src) throw new Error("Unsafe preview URL");
      state.debriefPreviewCache.set(adId, src);
      return src;
    })
    .catch((error) => {
      state.debriefPreviewCache.delete(adId);
      throw error;
    });
  state.debriefPreviewCache.set(adId, pending);
  return await pending;
}

function debriefStageDetailTable(row) {
  const stages = [
    ["Testing", row.testing],
    ["Scaled", row.scaled],
  ];
  return `<table class="analysis-data-table debrief-table stage-detail-table">
    <thead><tr><th class="sticky-cell">Stage</th><th>Spend</th><th>Impressions</th><th>Clicks</th><th>Installs</th><th>Sign-ups</th><th>CPI</th><th>CPSU</th><th>CTR</th><th>D1</th><th>D3</th><th>D7</th><th>Retained-user cost</th><th>Confidence</th></tr></thead>
    <tbody>${stages
      .map(
        ([label, metrics]) => `<tr>
          <td class="sticky-cell"><strong>${label}</strong></td>
          <td>${money(metrics.spend)}</td>
          <td>${integer(metrics.impressions)}</td>
          <td>${integer(metrics.clicks)}</td>
          <td>${integer(metrics.installs)}</td>
          <td>${integer(metrics.signups)}</td>
          <td>${debriefMoney(metrics.cpi)}</td>
          <td>${debriefMoney(metrics.cpsu)}</td>
          <td>${pct(metrics.ctr)}</td>
          <td>${debriefPct(metrics.d1)}</td>
          <td>${debriefPct(metrics.d3)}</td>
          <td>${debriefPct(metrics.d7)}</td>
          <td>${debriefMoney(metrics.retentionCost)}</td>
          <td>${debriefConfidenceChip(metrics.confidence)}</td>
        </tr>`,
      )
      .join("")}</tbody>
  </table>`;
}

function debriefDetailOverview(row) {
  return `
    <div class="overview-grid">
      <section class="detail-section key-metric-card"><span>Recommended action</span><strong>${escapeHtml(row.recommendedAction)}</strong><p>${escapeHtml(row.actionReason)}</p></section>
      <section class="detail-section key-metric-card"><span>Testing cost / sign-up</span><strong>${debriefMoney(row.testing.cpsu)}</strong><p>${money(row.testing.spend, true)} testing · ${money(row.scaled.spend, true)} scaled</p></section>
    </div>
    <section class="detail-section hierarchy">
      <div class="section-title">Creative context</div>
      <dl>
        <div><dt>Source</dt><dd>${escapeHtml(row.source)}</dd></div>
        <div><dt>Format</dt><dd>${escapeHtml(row.format)}</dd></div>
        <div><dt>Operating system</dt><dd>${escapeHtml(row.os)}</dd></div>
        <div><dt>Uploaded</dt><dd>${escapeHtml(debriefDay(row.uploadedDate))}</dd></div>
        <div><dt>Stage</dt><dd>${row.promoted ? "Testing + scaled" : "Testing only"}</dd></div>
        <div><dt>Status</dt><dd>${escapeHtml(row.status)}</dd></div>
        <div class="wide"><dt>Campaigns</dt><dd>${escapeHtml(row.campaigns.join("\\n") || "—")}</dd></div>
        <div class="wide"><dt>Ad sets</dt><dd>${escapeHtml(row.adSets.join("\\n") || "—")}</dd></div>
      </dl>
    </section>`;
}

function debriefDetailPerformance(row) {
  return `
    <section class="detail-section">
      <div class="section-title">Testing versus scaled performance</div>
      <div class="data-table-wrap retention-table-wrap">${debriefStageDetailTable(row)}</div>
    </section>
    <section class="detail-section">
      <div class="section-title">Testing maturity</div>
      <div class="list-metrics">
        <div><span>Spend to decision</span><strong>${row.spendToDecision > 0 ? money(row.spendToDecision) : "Ready"}</strong></div>
        <div><span>Days to decision</span><strong>${row.daysToDecision == null ? "—" : row.daysToDecision === 0 ? "Ready" : `${integer(row.daysToDecision)}d`}</strong></div>
        <div><span>Mature horizon</span><strong>${escapeHtml(row.retentionHorizon || "—")}</strong></div>
        <div><span>Confidence</span><strong>${escapeHtml(row.retentionConfidence || "No mature cohort")}</strong></div>
      </div>
    </section>`;
}

function debriefDetailInsights(row) {
  const benchmarks = (state.debrief?.segmentBenchmarks || []).filter(
    (item) =>
      (item.dimension === "Source" && item.segment === row.source) ||
      (item.dimension === "OS" && item.segment === row.os) ||
      (item.dimension === "Format" && item.segment === row.format),
  );
  return `
    <section class="detail-section">
      <div class="section-title">Decision rationale</div>
      <p>${escapeHtml(row.actionReason)}</p>
      ${(row.reasons || []).map((reason) => `<p>${escapeHtml(reason)}</p>`).join("")}
    </section>
    <section class="detail-section">
      <div class="section-title">Relevant testing benchmarks</div>
      <div class="data-table-wrap retention-table-wrap">${renderDebriefSegmentBenchmarks(benchmarks)}</div>
    </section>`;
}

function renderDebriefDetail() {
  const detail = state.debriefDetail;
  if (!detail) return;
  const row = detail.row;
  const thumbnail = safeUrl(row.thumbnailUrl);
  const pane =
    detail.tab === "performance"
      ? debriefDetailPerformance(row)
      : detail.tab === "insights"
        ? debriefDetailInsights(row)
        : debriefDetailOverview(row);
  $("dialogContent").innerHTML = `
    <div class="detail-shell">
      <header class="detail-header"><strong>${escapeHtml(row.readableName)}</strong><div>${debriefVerdictChip(row)}</div></header>
      <div class="detail-layout">
        <aside class="detail-left">
          <div class="media-mode"><span class="active">Preview</span><span>${row.promoted ? "Testing + scaled" : "Testing only"}</span></div>
          <div class="detail-media">
            ${
              detail.previewSrc
                ? `<iframe src="${escapeHtml(detail.previewSrc)}" allow="autoplay; fullscreen" title="${escapeHtml(row.readableName)}"></iframe>`
                : thumbnail
                  ? `<div class="media-frame"><img src="${escapeHtml(thumbnail)}" alt="${escapeHtml(row.readableName)}" />${detail.previewLoading ? '<div class="preview-loading"><div class="spinner"></div></div>' : ""}</div>`
                  : '<div class="media-empty">No media preview</div>'
            }
          </div>
          <p class="selected-ad-name">${escapeHtml(row.name)}</p>
        </aside>
        <section class="detail-right">
          <nav class="detail-tabs">
            <button data-debrief-detail-tab="overview" class="${detail.tab === "overview" ? "active" : ""}">Overview</button>
            <button data-debrief-detail-tab="performance" class="${detail.tab === "performance" ? "active" : ""}">Performance</button>
            <button data-debrief-detail-tab="insights" class="${detail.tab === "insights" ? "active" : ""}">Insights</button>
          </nav>
          <div class="detail-pane">${pane}</div>
        </section>
      </div>
    </div>`;
  $("dialogContent")
    .querySelectorAll("[data-debrief-detail-tab]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        state.debriefDetail.tab = button.dataset.debriefDetailTab;
        renderDebriefDetail();
      });
    });
}

async function openDebriefDetail(button) {
  const creativeName = button.dataset.debriefCreative;
  const row = state.debrief?.all?.find((item) => item.name === creativeName);
  if (!row) return;
  hideDebriefHoverPreview();
  state.detail = null;
  state.debriefDetail = {
    row,
    tab: "overview",
    previewSrc: null,
    previewLoading: Boolean(row.adIds?.[0]),
  };
  renderDebriefDetail();
  if (!dialog.open) dialog.showModal();
  const adId = row.adIds?.[0];
  if (!adId) return;
  try {
    const src = await fetchDebriefPreview(adId);
    if (state.debriefDetail?.row.name !== row.name) return;
    state.debriefDetail.previewSrc = src;
  } catch {
    // Keep the thumbnail when Meta cannot render this preview.
  } finally {
    if (state.debriefDetail?.row.name === row.name) {
      state.debriefDetail.previewLoading = false;
      renderDebriefDetail();
    }
  }
}

function hoverPreviewElement() {
  let element = $("debriefHoverPreview");
  if (!element) {
    element = document.createElement("div");
    element.id = "debriefHoverPreview";
    element.className = "debrief-hover-preview hidden";
    document.body.append(element);
  }
  return element;
}

function hideDebriefHoverPreview() {
  if (state.debriefHoverTimer) clearTimeout(state.debriefHoverTimer);
  state.debriefHoverTimer = null;
  state.debriefHoverButton = null;
  $("debriefHoverPreview")?.classList.add("hidden");
}

function showDebriefHoverPreview(button) {
  hideDebriefHoverPreview();
  state.debriefHoverButton = button;
  const element = hoverPreviewElement();
  const thumbnail = safeUrl(button.dataset.debriefThumbnail);
  const name = button.dataset.debriefName || "Creative preview";
  const rect = button.getBoundingClientRect();
  const width = 280;
  const height = 360;
  const left =
    rect.right + width + 16 <= window.innerWidth
      ? rect.right + 10
      : Math.max(8, rect.left - width - 10);
  const top = Math.max(8, Math.min(rect.top - 90, window.innerHeight - height - 8));
  element.style.left = `${left}px`;
  element.style.top = `${top}px`;
  element.innerHTML = `${thumbnail ? `<img src="${escapeHtml(thumbnail)}" alt="${escapeHtml(name)}" />` : ""}<div><strong>${escapeHtml(name)}</strong><span>Hover preview loading…</span></div>`;
  element.classList.remove("hidden");
  state.debriefHoverTimer = setTimeout(async () => {
    const adId = button.dataset.debriefPreview;
    if (!adId || state.debriefHoverButton !== button) return;
    try {
      const src = await fetchDebriefPreview(adId);
      if (state.debriefHoverButton !== button) return;
      element.innerHTML = `<iframe src="${escapeHtml(src)}" allow="autoplay" title="${escapeHtml(name)}"></iframe><div><strong>${escapeHtml(name)}</strong><span>Click for full details</span></div>`;
    } catch {
      if (state.debriefHoverButton === button) {
        element.querySelector("span").textContent =
          "Preview unavailable · click for details";
      }
    }
  }, 350);
}

function filteredDebriefRows() {
  const rows = state.debrief?.all ?? [];
  const query = $("debriefSearch").value.trim().toLowerCase();
  const source = $("debriefSourceFilter").value;
  const format = $("debriefFormatFilter").value;
  const os = $("debriefOsFilter").value;
  const stage = $("debriefStageFilter").value;
  const verdict = $("debriefVerdictFilter").value;
  const upload = $("debriefUploadFilter").value;
  const filtered = rows.filter((row) => {
    if (source !== "all" && row.source !== source) return false;
    if (format !== "all" && row.format !== format) return false;
    if (os !== "all" && row.os !== os) return false;
    if (stage === "testing" && row.promoted) return false;
    if (stage === "scaled" && !row.promoted) return false;
    if (verdict !== "all" && row.verdict !== verdict) return false;
    if (upload === "window" && row.carryover) return false;
    if (upload === "carryover" && !row.carryover) return false;
    if (!query) return true;
    return [row.name, row.readableName, row.creator, row.hook, ...row.adSets]
      .join(" ")
      .toLowerCase()
      .includes(query);
  });
  const numeric = (key, direction = "desc") => (a, b) => {
    const aValue = a[key];
    const bValue = b[key];
    if (aValue == null && bValue == null) return 0;
    if (aValue == null) return 1;
    if (bValue == null) return -1;
    return direction === "asc" ? aValue - bValue : bValue - aValue;
  };
  const testingNumeric = (key, direction = "desc") => (a, b) => {
    const aValue = a.testing?.[key];
    const bValue = b.testing?.[key];
    if (aValue == null && bValue == null) return 0;
    if (aValue == null) return 1;
    if (bValue == null) return -1;
    return direction === "asc" ? aValue - bValue : bValue - aValue;
  };
  const comparators = {
    newest: (a, b) =>
      (b.uploadedAt ?? "").localeCompare(a.uploadedAt ?? "") ||
      b.spend - a.spend,
    spend: numeric("spend"),
    testingSpend: testingNumeric("spend"),
    scaledSpend: numeric("scaledSpend"),
    signups: testingNumeric("signups"),
    cpsu: testingNumeric("cpsu", "asc"),
    cpi: testingNumeric("cpi", "asc"),
    d1: testingNumeric("d1"),
    d3: testingNumeric("d3"),
    d7: testingNumeric("d7"),
    costD1: testingNumeric("costPerRetainedD1", "asc"),
    costD3: testingNumeric("costPerRetainedD3", "asc"),
    costD7: testingNumeric("costPerRetainedD7", "asc"),
    retentionCost: numeric("retentionCostIndex", "asc"),
  };
  return filtered.sort(
    comparators[$("debriefSort").value] || comparators.newest,
  );
}

function renderDebriefAll() {
  if (!state.debrief) return;
  const rows = filteredDebriefRows();
  const pageSize = 25;
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  state.debriefPageNumber = Math.min(
    Math.max(1, state.debriefPageNumber),
    totalPages,
  );
  const start = (state.debriefPageNumber - 1) * pageSize;
  const pageRows = rows.slice(start, start + pageSize);
  $("debriefCount").textContent = rows.length
    ? `${start + 1}–${Math.min(start + pageSize, rows.length)} of ${rows.length} filtered`
    : `0 of ${state.debrief.all.length} tested`;
  $("debriefPageStatus").textContent =
    `Page ${state.debriefPageNumber} of ${totalPages}`;
  $("debriefPreviousPage").disabled = state.debriefPageNumber <= 1;
  $("debriefNextPage").disabled =
    state.debriefPageNumber >= totalPages || rows.length === 0;
  if (!rows.length) {
    $("debriefAll").innerHTML =
      '<div class="analysis-empty">No tested creatives match these filters.</div>';
    return;
  }
  const columns = [
    {
      label: "Creative",
      presets: ["always"],
      headerClass: "sticky-cell",
      cell: debriefCreativeCell,
    },
    {
      label: "Action",
      presets: ["decision"],
      cell: (row) =>
        `<td><span class="debrief-action-pill action-${row.recommendedAction.toLowerCase()}">${escapeHtml(row.recommendedAction)}</span></td>`,
    },
    {
      label: "Why",
      presets: ["decision"],
      cell: (row) =>
        `<td class="debrief-reasons">${escapeHtml(row.actionReason)}</td>`,
    },
    {
      label: "Verdict",
      presets: ["decision"],
      cell: (row) => `<td>${debriefVerdictChip(row)}</td>`,
    },
    {
      label: "Uploaded",
      presets: ["delivery"],
      cell: (row) =>
        `<td title="${escapeHtml(row.uploadedAt || "")}">${debriefShortDay(row.uploadedDate)}</td>`,
    },
    {
      label: "Source",
      presets: ["delivery"],
      cell: (row) => `<td>${escapeHtml(row.source)}</td>`,
    },
    {
      label: "Format",
      presets: ["delivery"],
      cell: (row) => `<td>${escapeHtml(row.format)}</td>`,
    },
    {
      label: "OS",
      presets: ["delivery"],
      cell: (row) => `<td>${escapeHtml(row.os)}</td>`,
    },
    {
      label: "Stage",
      presets: ["delivery"],
      cell: (row) =>
        `<td>${row.promoted ? "Testing + scaled" : "Testing only"}</td>`,
    },
    {
      label: "Total spend",
      presets: ["delivery"],
      cell: (row) => `<td>${money(row.spend)}</td>`,
    },
    {
      label: "Testing spend",
      presets: ["decision", "acquisition", "retention", "delivery"],
      cell: (row) => `<td>${money(row.testing.spend)}</td>`,
    },
    {
      label: "Scaled spend",
      presets: ["delivery"],
      cell: (row) =>
        `<td>${row.scaled.spend > 0 ? money(row.scaled.spend) : "—"}</td>`,
    },
    {
      label: "Spend remaining",
      presets: ["decision"],
      cell: (row) =>
        `<td>${row.spendToDecision > 0 ? money(row.spendToDecision) : "Ready"}</td>`,
    },
    {
      label: "Mature horizon",
      presets: ["decision"],
      cell: (row) => `<td>${escapeHtml(row.retentionHorizon || "—")}</td>`,
    },
    {
      label: "Retained-user cost",
      presets: ["decision"],
      cell: (row) => `<td>${debriefMoney(row.retentionCost)}</td>`,
    },
    {
      label: "Testing sign-ups",
      presets: ["acquisition"],
      cell: (row) => `<td>${integer(row.testing.signups)}</td>`,
    },
    {
      label: "Testing cost / sign-up",
      presets: ["decision", "acquisition"],
      cell: (row) => `<td><strong>${debriefMoney(row.testing.cpsu)}</strong></td>`,
    },
    {
      label: "Testing CPI",
      presets: ["acquisition"],
      cell: (row) => `<td>${debriefMoney(row.testing.cpi)}</td>`,
    },
    {
      label: "Testing CTR",
      presets: ["acquisition"],
      cell: (row) => `<td>${pct(row.testing.ctr)}</td>`,
    },
    {
      label: "Testing D1",
      presets: ["retention"],
      cell: (row) => `<td>${debriefStageRetention(row, 1)}</td>`,
    },
    {
      label: "Cost / D1 retained",
      presets: ["retention"],
      cell: (row) => `<td>${debriefRetentionCost(row, 1)}</td>`,
    },
    {
      label: "Testing D3",
      presets: ["retention"],
      cell: (row) => `<td>${debriefStageRetention(row, 3)}</td>`,
    },
    {
      label: "Cost / D3 retained",
      presets: ["retention"],
      cell: (row) => `<td>${debriefRetentionCost(row, 3)}</td>`,
    },
    {
      label: "Testing D7",
      presets: ["retention"],
      cell: (row) => `<td>${debriefStageRetention(row, 7)}</td>`,
    },
    {
      label: "Cost / D7 retained",
      presets: ["retention"],
      cell: (row) => `<td>${debriefRetentionCost(row, 7)}</td>`,
    },
    {
      label: "Confidence",
      presets: ["decision", "retention"],
      cell: (row) => `<td>${debriefConfidenceChip(row.retentionConfidence)}</td>`,
    },
  ];
  const preset = $("debriefColumnPreset").value;
  const visibleColumns = columns.filter(
    (column) =>
      preset === "all" ||
      column.presets.includes("always") ||
      column.presets.includes(preset),
  );
  $("debriefAll").innerHTML = `<table class="analysis-data-table debrief-table"><thead><tr>${visibleColumns
    .map(
      (column) =>
        `<th class="${column.headerClass || ""}">${column.label}</th>`,
    )
    .join("")}</tr></thead><tbody>${pageRows
    .map((row) => `<tr>${visibleColumns.map((column) => column.cell(row)).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

function renderDebriefLearnings() {
  if (!state.debrief) return;
  const launched = state.debrief.all.filter(
    (row) =>
      row.uploadedDate &&
      row.uploadedDate >= state.debrief.range.since &&
      row.uploadedDate <= state.debrief.range.until,
  );
  const dimension = $("debriefLearningDimension").value;
  const valueFor = {
    format: (row) => row.format,
    source: (row) => row.source,
    os: (row) => row.os,
    concept: (row) => row.testingAdSets?.[0] || row.category,
  }[dimension];
  const groups = new Map();
  for (const row of launched) {
    const value = valueFor(row) || "Unknown";
    const group = groups.get(value) || [];
    group.push(row);
    groups.set(value, group);
  }
  const rollups = [...groups.entries()]
    .map(([value, creatives]) => {
      const sum = (key) =>
        creatives.reduce(
          (total, row) => total + Number(row.testing?.[key] || 0),
          0,
        );
      const retention = (day) => {
        const cohort = sum(`d${day}Cohort`);
        return cohort > 0
          ? (sum(`retainedD${day}`) / cohort) * 100
          : null;
      };
      const winners = creatives.filter(
        (row) => row.verdict === "Winner",
      ).length;
      const losers = creatives.filter(
        (row) => row.verdict === "Loser",
      ).length;
      const middle = creatives.filter(
        (row) => row.verdict === "Middle",
      ).length;
      const learning = creatives.filter(
        (row) => row.verdict === "Learning",
      ).length;
      const decided = winners + losers + middle;
      const testingSpend = sum("spend");
      const signups = sum("signups");
      return {
        value,
        tested: creatives.length,
        decided,
        winners,
        losers,
        middle,
        learning,
        winRate: decided > 0 ? (winners / decided) * 100 : null,
        testingSpend,
        signups,
        cpsu: signups > 0 ? testingSpend / signups : null,
        d1: retention(1),
        d3: retention(3),
        d7: retention(7),
      };
    })
    .sort(
      (a, b) =>
        (b.winRate ?? -1) - (a.winRate ?? -1) ||
        b.decided - a.decided ||
        b.testingSpend - a.testingSpend,
    );
  const decidedTotal = rollups.reduce(
    (sum, row) => sum + row.decided,
    0,
  );
  const winnersTotal = rollups.reduce(
    (sum, row) => sum + row.winners,
    0,
  );
  $("debriefVisualCoverage").textContent =
    `${integer(launched.length)} creatives launched · ${integer(decidedTotal)} decided · ${integer(launched.length - decidedTotal)} still learning · overall win rate ${decidedTotal > 0 ? pct((winnersTotal / decidedTotal) * 100) : "—"}.`;
  $("debriefLearnings").innerHTML = rollups.length
    ? `<table class="analysis-data-table debrief-table win-rate-table">
      <thead><tr><th class="sticky-cell">${dimension === "concept" ? "Concept / ad group" : dimension.charAt(0).toUpperCase() + dimension.slice(1)}</th><th>Tested</th><th>Decided</th><th>Winners</th><th>Losers</th><th>Middle</th><th>Learning</th><th>Win rate</th><th>Testing spend</th><th>Sign-ups</th><th>CPSU</th><th>D1</th><th>D3</th><th>D7</th></tr></thead>
      <tbody>${rollups
        .map(
          (row) => `<tr>
            <td class="sticky-cell"><strong>${escapeHtml(row.value)}</strong></td>
            <td>${integer(row.tested)}</td>
            <td>${integer(row.decided)}</td>
            <td>${integer(row.winners)}</td>
            <td>${integer(row.losers)}</td>
            <td>${integer(row.middle)}</td>
            <td>${integer(row.learning)}</td>
            <td><strong>${debriefPct(row.winRate)}</strong></td>
            <td>${money(row.testingSpend, true)}</td>
            <td>${integer(row.signups)}</td>
            <td>${debriefMoney(row.cpsu)}</td>
            <td>${debriefPct(row.d1)}</td>
            <td>${debriefPct(row.d3)}</td>
            <td>${debriefPct(row.d7)}</td>
          </tr>`,
        )
        .join("")}</tbody>
    </table>`
    : '<div class="analysis-empty">No creatives were launched in this period.</div>';
}

function setDebriefSection(section) {
  state.debriefSection = section;
  document.querySelectorAll("[data-debrief-section]").forEach((button) => {
    button.classList.toggle(
      "active",
      button.dataset.debriefSection === section,
    );
  });
  document
    .querySelectorAll("[data-debrief-section-panel]")
    .forEach((panel) => {
      panel.classList.toggle(
        "hidden",
        panel.dataset.debriefSectionPanel !== section,
      );
    });
  if (section === "decisions") renderDebriefTestedCreatives();
  else if (section === "learnings") renderDebriefLearnings();
  else if (section === "all") renderDebriefAll();
  else if (section === "experiments") void loadExperiments();
}

function renderDebrief() {
  const data = state.debrief;
  if (!data) return;
  const s = data.summary;
  const freshness = data.freshness;
  $("debriefStatus").textContent =
    `${debriefDay(s.since)} → ${debriefDay(s.until)} · Meta partner in ${data.adjustApp} · updated ${new Date(data.generatedAt).toLocaleString()}` +
    (freshness?.refreshing ? " · refreshing in background…" : "") +
    (freshness?.source === "disk" ? " · restored snapshot" : "");
  $("debriefHeadline").innerHTML =
    `<strong>${integer(s.tested)} creatives tested since ${debriefDay(s.since)}:</strong> ` +
    `${integer(s.winners)} winners, ${integer(s.losers)} losers, ${integer(s.promoted)} scaled, ${integer(s.learning)} still learning.`;
  $("debriefSummary").innerHTML = `
    <div><span>Tested</span><strong>${integer(s.tested)}</strong></div>
    <div><span>Scale</span><strong>${integer((data.decisions || []).filter((row) => row.recommendedAction === "Scale").length)}</strong></div>
    <div><span>Pause</span><strong>${integer((data.decisions || []).filter((row) => row.recommendedAction === "Pause").length)}</strong></div>
    <div><span>Iterate</span><strong>${integer((data.decisions || []).filter((row) => row.recommendedAction === "Iterate").length)}</strong></div>
    <div><span>Wait</span><strong>${integer((data.decisions || []).filter((row) => row.recommendedAction === "Wait").length)}</strong></div>
    <div><span>Testing spend</span><strong>${money(s.testingSpend, true)}</strong></div>
    <div><span>Testing CPSU</span><strong>${debriefMoney(s.cpsu)}</strong></div>
    <div><span>D7 benchmark</span><strong>${debriefPct(data.benchmarks?.average?.d7)}</strong></div>`;
  $("debriefBenchmarks").innerHTML = renderDebriefBenchmarks(data.benchmarks);
  renderDebriefTestedCreatives();
  $("debriefSegmentBenchmarks").innerHTML =
    renderDebriefSegmentBenchmarks(data.segmentBenchmarks);
  $("debriefSources").innerHTML = renderDebriefSources(data.bySource);
  renderDebriefLearnings();
  $("debriefScaledValidation").innerHTML =
    renderScaleCandidates(
      (data.decisions || []).filter(
        (row) => row.recommendedAction === "Scale" && !row.promoted,
      ),
    );
  $("debriefRules").innerHTML = Object.values(data.rules)
    .map((rule) => `<li>${escapeHtml(rule)}</li>`)
    .join("");

  const sourceSelect = $("debriefSourceFilter");
  const selected = sourceSelect.value;
  sourceSelect.innerHTML =
    '<option value="all">All sources</option>' +
    data.bySource
      .map(
        (row) =>
          `<option value="${escapeHtml(row.source)}">${escapeHtml(row.source)} (${row.tested})</option>`,
      )
      .join("");
  if (data.bySource.some((row) => row.source === selected)) {
    sourceSelect.value = selected;
  }
  renderDebriefAll();
  setDebriefSection(state.debriefSection);

  $("debriefWarning").textContent = data.warnings.join(" ");
  $("debriefWarning").classList.toggle("hidden", !data.warnings.length);
  $("debriefContent").classList.remove("hidden");
}

function scheduleDebriefPoll(previousGeneratedAt, attempt = 0) {
  if (state.debriefPollTimer) clearTimeout(state.debriefPollTimer);
  if (attempt >= 40 || state.page !== "debrief") return;
  state.debriefPollTimer = setTimeout(async () => {
    try {
      const params = new URLSearchParams();
      const since = $("debriefSince").value;
      const until = $("debriefUntil").value;
      if (since) params.set("since", since);
      if (until) params.set("until", until);
      const response = await fetch(`/api/debrief?${params}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Refresh unavailable");
      state.debrief = data;
      renderDebrief();
      if (
        data.generatedAt === previousGeneratedAt ||
        data.freshness?.refreshing
      ) {
        scheduleDebriefPoll(previousGeneratedAt, attempt + 1);
      }
    } catch {
      scheduleDebriefPoll(previousGeneratedAt, attempt + 1);
    }
  }, 3000);
}

async function loadDebrief(force = false) {
  if (state.debriefLoading) return;
  const since = $("debriefSince").value;
  const until = $("debriefUntil").value;
  if (
    !force &&
    state.debrief?.range.since === since &&
    state.debrief?.range.until === until
  ) {
    renderDebrief();
    return;
  }
  state.debriefLoading = true;
  $("debriefLoading").classList.remove("hidden");
  $("debriefWarning").classList.add("hidden");
  $("applyDebrief").disabled = true;
  $("refreshDebrief").disabled = true;
  $("debriefStatus").textContent = "Loading test results…";
  try {
    const params = new URLSearchParams();
    if (since) params.set("since", since);
    if (until) params.set("until", until);
    if (force) params.set("refresh", "1");
    const response = await fetch(`/api/debrief?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Test debrief unavailable");
    state.debrief = data;
    renderDebrief();
    if (data.freshness?.refreshing) {
      scheduleDebriefPoll(data.generatedAt);
    }
  } catch (error) {
    $("debriefStatus").textContent = error.message;
    $("debriefWarning").textContent = error.message;
    $("debriefWarning").classList.remove("hidden");
  } finally {
    state.debriefLoading = false;
    $("debriefLoading").classList.add("hidden");
    $("applyDebrief").disabled = false;
    $("refreshDebrief").disabled = false;
  }
}

function applyDebriefWindowPreset() {
  const days = Number($("debriefWindowPreset").value);
  if (!Number.isInteger(days)) return;
  const until = new Date();
  until.setUTCHours(0, 0, 0, 0);
  until.setUTCDate(until.getUTCDate() - 1);
  const since = new Date(until);
  since.setUTCDate(since.getUTCDate() - (days - 1));
  $("debriefSince").value = since.toISOString().slice(0, 10);
  $("debriefUntil").value = until.toISOString().slice(0, 10);
}

function switchPage(page) {
  state.page = page;
  if (page !== "debrief" && state.debriefPollTimer) {
    clearTimeout(state.debriefPollTimer);
    state.debriefPollTimer = null;
  }
  $("libraryPage").classList.toggle("hidden", page !== "library");
  $("analysisPage").classList.toggle("hidden", page !== "analysis");
  $("inspirationPage").classList.toggle("hidden", page !== "inspiration");
  $("debriefPage").classList.toggle("hidden", page !== "debrief");
  document.querySelectorAll("[data-page]").forEach((button) => {
    button.classList.toggle("active", button.dataset.page === page);
  });
  if (page === "library" && !state.payload) void loadData();
  if (page === "analysis") {
    if (state.payload) {
      void loadAnalysis();
      if (!state.videoMetrics) void loadVideoMetrics();
    } else {
      void loadData();
    }
  }
  if (page === "inspiration") void loadCompetitors();
  if (page === "debrief") void loadDebrief();
}

async function startScan(force) {
  const scanButton = $("scanButton");
  const rescanButton = $("rescanButton");
  scanButton.disabled = true;
  rescanButton.disabled = true;
  $("scanProgress").classList.remove("hidden");
  $("scanProgress").textContent = "Starting creative scan…";
  try {
    const response = await fetch(
      `/api/analysis/scan?${currentRangeParams()}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          limit: Number($("scanLimit").value),
          force,
        }),
      },
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not start scan");
    state.scanJob = data.job;
    pollScan(data.job.id);
  } catch (error) {
    $("scanProgress").textContent = error.message;
    scanButton.disabled = false;
    rescanButton.disabled = false;
  }
}

async function pollScan(jobId) {
  try {
    const response = await fetch(
      `/api/analysis/status?jobId=${encodeURIComponent(jobId)}`,
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Scan status unavailable");
    const job = data.job;
    state.scanJob = job;
    const total = job.total || Number($("scanLimit").value);
    $("scanProgress").textContent =
      `${job.status === "running" ? "Scanning" : job.status} · ${job.completed}/${total}` +
      (job.current ? ` · ${job.current}` : "") +
      (job.failed ? ` · ${job.failed} failed` : "");
    if (job.status === "queued" || job.status === "running") {
      setTimeout(() => void pollScan(jobId), 1500);
      return;
    }
    $("scanButton").disabled = false;
    $("rescanButton").disabled = false;
    await loadAnalysis();
  } catch (error) {
    $("scanProgress").textContent = error.message;
    $("scanButton").disabled = false;
    $("rescanButton").disabled = false;
  }
}

["sortMetric", "mediaType", "performanceSlice", "minimumSpend"].forEach((id) =>
  $(id).addEventListener("change", render),
);
$("searchInput").addEventListener("input", render);
$("audienceSlice").addEventListener("change", (event) =>
  setActiveSlice("publisher", event.currentTarget),
);
$("demographicSlice").addEventListener("change", (event) =>
  setActiveSlice("demographic", event.currentTarget),
);
$("deviceSlice").addEventListener("change", (event) =>
  setActiveSlice("device", event.currentTarget),
);
$("osSlice").addEventListener("change", (event) =>
  setActiveSlice("os", event.currentTarget),
);
for (const [dimension, config] of Object.entries(sliceControls)) {
  for (const eventName of ["pointerenter", "focus"]) {
    $(config.id).addEventListener(eventName, () => void loadSlice(dimension));
  }
}
$("datePreset").addEventListener("change", () => {
  const custom = $("datePreset").value === "custom";
  $("customDates").classList.toggle("hidden", !custom);
  if (custom && state.payload) {
    $("sinceDate").value = state.payload.range.since;
    $("untilDate").value = state.payload.range.until;
  }
  if (!custom) void loadData();
});
$("applyDates").addEventListener("click", () => void loadData());
$("refreshButton").addEventListener("click", () => void loadData(true));
$("exportCsvButton").addEventListener("click", exportFilteredCsv);
$("saveViewButton").addEventListener("click", () =>
  void saveCurrentView().catch((error) => window.alert(error.message)),
);
$("copySlackSummaryButton").addEventListener("click", () =>
  void copySlackSummary().catch((error) => window.alert(error.message)),
);
$("compareNowButton").addEventListener("click", openComparison);
$("clearCompareButton").addEventListener("click", () => {
  state.compareIds.clear();
  render();
});
[$("metricDictionaryButton"), $("dataHealthBanner")].forEach((button) => {
  button.addEventListener("click", () => {
    renderMetricDictionary();
    $("metricDictionaryDialog").showModal();
  });
});
$("closeMetricDictionary").addEventListener("click", () =>
  $("metricDictionaryDialog").close(),
);
$("metricDictionaryDialog").addEventListener("click", (event) => {
  if (event.target === $("metricDictionaryDialog")) {
    $("metricDictionaryDialog").close();
  }
});
$("workspaceButton").addEventListener("click", () => {
  void loadWorkspace().then(() => $("workspaceDialog").showModal());
});
$("closeWorkspace").addEventListener("click", () =>
  $("workspaceDialog").close(),
);
$("workspaceDialog").addEventListener("click", (event) => {
  if (event.target === $("workspaceDialog")) {
    $("workspaceDialog").close();
    return;
  }
  const reportId = event.target.closest("[data-delete-report]")?.dataset
    .deleteReport;
  if (reportId) {
    void fetch(`/api/saved-reports?id=${encodeURIComponent(reportId)}`, {
      method: "DELETE",
    }).then(loadWorkspace);
  }
});
$("experimentForm").addEventListener("submit", (event) =>
  void saveExperiment(event).catch((error) => window.alert(error.message)),
);
$("clearExperimentForm").addEventListener("click", clearExperimentForm);
$("experimentList").addEventListener("click", (event) => {
  const editId = event.target.closest("[data-edit-experiment]")?.dataset
    .editExperiment;
  if (editId) {
    const experiment = state.experiments.find((item) => item.id === editId);
    if (!experiment) return;
    $("experimentId").value = experiment.id;
    $("experimentName").value = experiment.name;
    $("experimentOwner").value = experiment.owner;
    $("experimentStatus").value = experiment.status;
    $("experimentHypothesis").value = experiment.hypothesis;
    $("experimentControl").value = experiment.control;
    $("experimentVariants").value = experiment.variants;
    $("experimentPrimaryMetric").value = experiment.primaryMetric;
    $("experimentGuardrails").value = experiment.guardrails;
    $("experimentNotes").value = experiment.notes;
    return;
  }
  const deleteId = event.target.closest("[data-delete-experiment]")?.dataset
    .deleteExperiment;
  if (deleteId) {
    void fetch(`/api/experiments?id=${encodeURIComponent(deleteId)}`, {
      method: "DELETE",
    }).then(loadExperiments);
  }
});
$("closeDialog").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => {
  state.detail = null;
  state.debriefDetail = null;
  hideDebriefHoverPreview();
});
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});

document.querySelectorAll("[data-page]").forEach((button) => {
  button.addEventListener("click", () => switchPage(button.dataset.page));
});
document.querySelectorAll("[data-analysis-report]").forEach((button) => {
  button.addEventListener("click", () =>
    setAnalysisReport(button.dataset.analysisReport),
  );
});
$("scanButton").addEventListener("click", () => void startScan(false));
$("rescanButton").addEventListener("click", () => void startScan(true));
$("competitorBrand").addEventListener("change", renderCompetitors);
$("refreshCompetitors").addEventListener("click", () =>
  void loadCompetitors(true),
);
$("applyDebrief").addEventListener("click", () => void loadDebrief());
$("refreshDebrief").addEventListener("click", () => void loadDebrief(true));
$("debriefWindowPreset").addEventListener("change", () => {
  if ($("debriefWindowPreset").value !== "custom") {
    applyDebriefWindowPreset();
    void loadDebrief();
  }
});
["debriefSince", "debriefUntil"].forEach((id) => {
  $(id).addEventListener("change", () => {
    $("debriefWindowPreset").value = "custom";
  });
});
$("debriefPage").addEventListener("click", (event) => {
  const testedConcept = event.target.closest("[data-tested-concept]")?.dataset
    .testedConcept;
  if (testedConcept) {
    if (state.expandedTestedGroups.has(testedConcept)) {
      state.expandedTestedGroups.delete(testedConcept);
    } else {
      state.expandedTestedGroups.add(testedConcept);
    }
    renderDebriefTestedCreatives();
    return;
  }
  const button = event.target.closest("[data-debrief-preview]");
  if (button) void openDebriefDetail(button);
});
$("debriefPage").addEventListener("pointerover", (event) => {
  const button = event.target.closest("[data-debrief-preview]");
  if (button && !button.contains(event.relatedTarget)) {
    showDebriefHoverPreview(button);
  }
});
$("debriefPage").addEventListener("pointerout", (event) => {
  const button = event.target.closest("[data-debrief-preview]");
  if (button && !button.contains(event.relatedTarget)) {
    hideDebriefHoverPreview();
  }
});
document.querySelectorAll("[data-debrief-section]").forEach((button) => {
  button.addEventListener("click", () =>
    setDebriefSection(button.dataset.debriefSection),
  );
});
$("debriefLearningDimension").addEventListener(
  "change",
  renderDebriefLearnings,
);
["debriefTestedVerdict", "debriefTestedSort"].forEach((id) => {
  $(id).addEventListener("change", () => {
    state.debriefTestedPageNumber = 1;
    renderDebriefTestedCreatives();
  });
});
$("debriefTestedPreviousPage").addEventListener("click", () => {
  state.debriefTestedPageNumber -= 1;
  renderDebriefTestedCreatives();
});
$("debriefTestedNextPage").addEventListener("click", () => {
  state.debriefTestedPageNumber += 1;
  renderDebriefTestedCreatives();
});
[
  "debriefSourceFilter",
  "debriefFormatFilter",
  "debriefOsFilter",
  "debriefStageFilter",
  "debriefVerdictFilter",
  "debriefUploadFilter",
  "debriefSort",
  "debriefColumnPreset",
].forEach((id) =>
  $(id).addEventListener("change", () => {
    state.debriefPageNumber = 1;
    renderDebriefAll();
  }),
);
$("debriefSearch").addEventListener("input", () => {
  state.debriefPageNumber = 1;
  renderDebriefAll();
});
$("debriefPreviousPage").addEventListener("click", () => {
  state.debriefPageNumber -= 1;
  renderDebriefAll();
});
$("debriefNextPage").addEventListener("click", () => {
  state.debriefPageNumber += 1;
  renderDebriefAll();
});

const initialQuery = new URLSearchParams(window.location.search);
const initialPage = initialQuery.get("page");
const initialReport = initialQuery.get("report");
const initialDays = initialQuery.get("days");
applyDebriefWindowPreset();
if (
  initialDays &&
  [...$("datePreset").options].some((option) => option.value === initialDays)
) {
  $("datePreset").value = initialDays;
}
if (initialQuery.get("since") && initialQuery.get("until")) {
  $("datePreset").value = "custom";
  $("sinceDate").value = initialQuery.get("since");
  $("untilDate").value = initialQuery.get("until");
  $("customDates").classList.remove("hidden");
}
for (const [parameter, id] of [
  ["sort", "sortMetric"],
  ["media", "mediaType"],
  ["performance", "performanceSlice"],
  ["minSpend", "minimumSpend"],
]) {
  const value = initialQuery.get(parameter);
  const select = $(id);
  if (value && [...select.options].some((option) => option.value === value)) {
    select.value = value;
  }
}
$("searchInput").value = initialQuery.get("search") || "";
if (
  [
    "overview",
    "hooks",
    "clicks",
    "copy",
    "retention",
    "landing",
    "data",
  ].includes(initialReport)
) {
  state.analysisReport = initialReport;
}
switchPage(
  ["library", "analysis", "inspiration", "debrief"].includes(initialPage)
    ? initialPage
    : "library",
);
