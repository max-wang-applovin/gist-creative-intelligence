const state = {
  payload: null,
  slices: { publisher: null, demographic: null, device: null, os: null },
  activeSlice: null,
  initialSliceApplied: false,
  initialDetailApplied: false,
  loading: false,
  selected: null,
  detail: null,
  page: "library",
  analysis: null,
  videoMetrics: null,
  competitors: null,
  scanJob: null,
  analysisReport: "overview",
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
    return `<div class="media-frame"><div class="media-empty">No Meta preview<br>for this grouping</div></div>`;
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
  grid.querySelectorAll(".creative-card").forEach((card) => {
    card.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      void openDetail(card.dataset.creative);
    });
  });
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

  try {
    const params = currentRangeParams();
    params.set("creativeId", creativeId);
    const response = await fetch(`/api/creative-detail?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Detail unavailable");
    if (state.detail?.row.creativeId !== creativeId) return;
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

function populateSliceControls() {
  const audience = $("audienceSlice");
  audience.replaceChildren();
  appendOption(audience, "all", "Audience All");
  for (const segment of state.slices.publisher?.segments || []) {
    appendOption(audience, segment.key, segment.label);
  }
  audience.disabled = false;

  const device = $("deviceSlice");
  device.replaceChildren();
  appendOption(device, "all", "Device All");
  for (const segment of state.slices.device?.segments || []) {
    appendOption(device, segment.key, segment.label);
  }
  device.disabled = false;

  const operatingSystem = $("osSlice");
  operatingSystem.replaceChildren();
  appendOption(operatingSystem, "all", "OS All");
  for (const segment of state.slices.os?.segments || []) {
    appendOption(operatingSystem, segment.key, segment.label);
  }
  operatingSystem.disabled = false;

  const demographic = $("demographicSlice");
  demographic.replaceChildren();
  appendOption(demographic, "all", "Demographic All");
  const segments = state.slices.demographic?.segments || [];
  const genders = [...new Set(segments.map((segment) => segment.gender))].filter(
    Boolean,
  );
  const ages = [...new Set(segments.map((segment) => segment.age))].filter(
    Boolean,
  );
  for (const gender of genders) {
    const label =
      gender === "female" ? "Women" : gender === "male" ? "Men" : "Unknown";
    appendOption(demographic, `gender:${gender}`, `${label} · All ages`);
  }
  for (const age of ages) {
    appendOption(demographic, `age:${age}`, `Age ${age} · All genders`);
  }
  for (const segment of segments) {
    appendOption(demographic, `segment:${segment.key}`, segment.label);
  }
  demographic.disabled = false;

  if (!state.initialSliceApplied) {
    state.initialSliceApplied = true;
    const query = new URLSearchParams(window.location.search);
    for (const [parameter, dimension, select] of [
      ["audience", "publisher", audience],
      ["demographic", "demographic", demographic],
      ["device", "device", device],
      ["os", "os", operatingSystem],
    ]) {
      const value = query.get(parameter);
      if (value && [...select.options].some((option) => option.value === value)) {
        select.value = value;
        setActiveSlice(dimension, select);
        break;
      }
    }
  }
}

function resetSlices() {
  state.activeSlice = null;
  state.slices = { publisher: null, demographic: null, device: null, os: null };
  for (const id of [
    "audienceSlice",
    "demographicSlice",
    "deviceSlice",
    "osSlice",
  ]) {
    $(id).disabled = true;
    $(id).value = "all";
  }
  $("sliceNotice").classList.add("hidden");
}

async function loadSlices(params) {
  const query = params.toString();
  try {
    const dimensions = ["publisher", "demographic", "device", "os"];
    const responses = await Promise.all(
      dimensions.map(async (dimension) => {
        const response = await fetch(
          `/api/slices?${query}&dimension=${dimension}`,
        );
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `${dimension} failed`);
        return [dimension, data];
      }),
    );
    for (const [dimension, data] of responses) {
      state.slices[dimension] = data;
    }
    populateSliceControls();
    if (state.detail?.tab === "insights") renderDetail();
  } catch (error) {
    warning.textContent = `${warning.textContent || ""} Slice filters unavailable: ${error.message}`.trim();
    warning.classList.remove("hidden");
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

async function loadData(force = false) {
  if (state.loading) return;
  state.loading = true;
  loading.classList.remove("hidden");
  grid.innerHTML = "";
  warning.classList.add("hidden");
  resetSlices();
  try {
    const params = currentRangeParams(force);
    const response = await fetch(`/api/creatives?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load creatives");
    state.payload = data;
    renderSummary();
    render();
    $("freshness").textContent = `${data.range.since} → ${data.range.until} · ${data.source} · ${data.adjustApp || "Adjust"}`;
    if (data.warnings?.length) {
      warning.textContent = data.warnings.join(" ");
      warning.classList.remove("hidden");
    }
    void loadSlices(params);
    void loadVideoMetrics(params);
    if (!state.initialDetailApplied) {
      state.initialDetailApplied = true;
      const creativeId = new URLSearchParams(window.location.search).get(
        "creative",
      );
      if (creativeId) void openDetail(creativeId);
    }
    if (state.page === "analysis") void loadAnalysis();
  } catch (error) {
    warning.textContent = error.message;
    warning.classList.remove("hidden");
    grid.innerHTML = '<div class="empty-state">Could not load dashboard data.</div>';
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
              <a href="${escapeHtml(creative.libraryUrl)}" target="_blank" rel="noreferrer">Open in Meta Ad Library ↗</a>
            </div>
          </article>`;
      })
      .join("") ||
    '<div class="analysis-empty">No official active creatives with reported GB views for this brand.</div>';
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
    minimum: day === 7 ? 50 : day === 3 ? 75 : 100,
  };
}

function retentionLeaders(rows, day, limit = 10) {
  const config = retentionConfig(day);
  return rows
    .filter(
      (row) =>
        row.metaSpend > 0 &&
        !row.creativeName.includes("{{") &&
        Number(row[config.denominator] || 0) >= config.minimum,
    )
    .sort(
      (a, b) =>
        Number(b[config.rate] || 0) - Number(a[config.rate] || 0) ||
        Number(b[config.denominator] || 0) -
          Number(a[config.denominator] || 0),
    )
    .slice(0, limit);
}

function retentionPanel(rows, day, limit = 7) {
  const config = retentionConfig(day);
  const leaders = retentionLeaders(rows, day, limit);
  return `
    <section class="retention-panel">
      <header><div><span>D${day}</span><strong>Top retention</strong></div><small>min ${config.minimum} mature installs</small></header>
      ${
        leaders.length
          ? leaders
              .map((row, index) => {
                const thumb = safeUrl(row.media[0]?.thumbnailUrl);
                return `<div class="retention-leader" data-analysis-creative="${escapeHtml(row.creativeId)}">
                  <span class="retention-rank">#${index + 1}</span>
                  ${thumb ? `<img src="${escapeHtml(thumb)}" alt="" />` : "<div></div>"}
                  <div><strong>${escapeHtml(row.creativeName)}</strong><small>${money(row.metaSpend, true)} spend · ${money(row.cpi)} CPI</small></div>
                  <div class="retention-value"><strong>${pct(row[config.rate])}</strong><small>${integer(row[config.numerator])}/${integer(row[config.denominator])}</small></div>
                </div>`;
              })
              .join("")
          : `<div class="analysis-empty">No mature D${day} cohort meets the minimum in this window. Choose a longer date range.</div>`
      }
    </section>`;
}

function renderRetentionReport(rows) {
  return (
    reportHeader(
      "Retention Leaders",
      "Highest D1/D3/D7 Adjust calendar-cohort retention with mature-cohort minimums; raw retained/mature counts shown.",
    ) +
    `<div class="retention-columns report-retention">${[1, 3, 7]
      .map((day) => retentionPanel(rows, day, 15))
      .join("")}</div>`
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
  $("retentionLeadersOverview").innerHTML = [1, 3, 7]
    .map((day) => retentionPanel(all, day, 5))
    .join("");

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

function switchPage(page) {
  state.page = page;
  $("libraryPage").classList.toggle("hidden", page !== "library");
  $("analysisPage").classList.toggle("hidden", page !== "analysis");
  $("inspirationPage").classList.toggle("hidden", page !== "inspiration");
  document.querySelectorAll("[data-page]").forEach((button) => {
    button.classList.toggle("active", button.dataset.page === page);
  });
  if (page === "analysis") void loadAnalysis();
  if (page === "inspiration") void loadCompetitors();
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
$("closeDialog").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => {
  state.detail = null;
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

const initialPage = new URLSearchParams(window.location.search).get("page");
const initialReport = new URLSearchParams(window.location.search).get("report");
const initialDays = new URLSearchParams(window.location.search).get("days");
if (
  initialDays &&
  [...$("datePreset").options].some((option) => option.value === initialDays)
) {
  $("datePreset").value = initialDays;
}
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
  ["library", "analysis", "inspiration"].includes(initialPage)
    ? initialPage
    : "library",
);
void loadData();
