// Chicago 311 Rain & Tree dashboard. One shared state object; every panel re-renders from it.
const API = "https://data.cityofchicago.org/resource/v6vf-nfxy.json";
const CA_GEOJSON = "https://data.cityofchicago.org/resource/igwz-8jzy.geojson";
const REFRESH_MS = 5 * 60 * 1000;

// Design-system sequential ramp seq-1..seq-5 (five classes max)
const SEQ = ["#eef5f8", "#bcd7e3", "#7fb1c9", "#3f84a8", "#145a6b"];
const MARKER_SIG = "#c02625", MARKER_NO = "#8a8a8a";   // map-marker-1, border-control
const CATS = [
  { k: "tree_emergency", type: "Tree Emergency", label: "Tree Emerg.", short: "TE", color: "#2f6b3a" },
  { k: "tree_debris", type: "Tree Debris Clean-Up Request", label: "Tree Debris", short: "TD", color: "#8fbf5a" },
  { k: "water_basement", type: "Water in Basement Complaint", label: "Water Basement", short: "WB", color: "#1f5fa8" },
  { k: "water_street", type: "Water On Street Complaint", label: "Water Street", short: "WS", color: "#6fb3e0" },
];
const TYPE2K = Object.fromEntries(CATS.map(c => [c.type, c.k]));

const state = {
  range: "7", cats: new Set(CATS.map(c => c.k)), mode: "heat", norm: "raw", peaks: [], hotKind: "all", hotMethod: "hu",
  points: [],            // {id,k,lat,lon,t,ca,status,addr}
  lastFetch: null, maxCreated: null,
  scope: { kind: "city", name: "Citywide" },   // city | ca | place
  radiusMi: 0.25, places: [], june: null, caNames: {}, caSort: "count",
};

const $ = id => document.getElementById(id);
const press = (group, btn) => group.querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === btn)));
const fmt = n => n.toLocaleString();
const pad = n => String(n).padStart(2, "0");
const isoLocal = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;

// ---------- data ----------
function rangeWindow() {
  if (state.range === "june") return [new Date(2026, 5, 1), new Date(2026, 6, 1)];
  if (state.range === "custom") {   // inclusive of the "to" day; open-ended (live) when "to" is today or later
    const [fy, fm, fd] = state.from.split("-").map(Number), [ty, tm, td] = state.to.split("-").map(Number);
    const until = new Date(ty, tm - 1, td + 1);
    return [new Date(fy, fm - 1, fd), until > new Date() ? null : until];
  }
  const end = new Date(); return [new Date(end - state.range * 864e5), null];
}

async function fetchSoda(since, until) {
  const types = CATS.map(c => `'${c.type}'`).join(",");
  let where = `sr_type in(${types}) AND duplicate=false AND created_date>'${isoLocal(since)}'`;
  if (until) where += ` AND created_date<'${isoLocal(until)}'`;
  const out = []; const page = 50000;
  for (let off = 0; ; off += page) {
    const q = new URLSearchParams({
      $select: "sr_number,sr_type,status,created_date,latitude,longitude,community_area,street_address",
      $where: where, $order: "created_date", $limit: page, $offset: off,
    });
    let r;
    for (let attempt = 0; attempt < 4; attempt++) {   // the portal returns 503 under load; back off and retry
      r = await fetch(`${API}?${q}`);
      if (r.ok || r.status < 500) break;
      setStatus(`311 API busy (${r.status}), retrying…`);
      await new Promise(res => setTimeout(res, 2000 * 2 ** attempt));
    }
    if (!r.ok) throw new Error(`311 API ${r.status}`);
    const rows = await r.json(); out.push(...rows);
    if (rows.length < page) break;
  }
  return out.filter(r => r.latitude && r.longitude).map(r => ({
    id: r.sr_number, k: TYPE2K[r.sr_type], lat: +r.latitude, lon: +r.longitude,
    t: new Date(r.created_date), ca: r.community_area || null, status: r.status, addr: r.street_address,
  }));
}

async function load(full = true) {
  setStatus("Fetching live 311…");
  try {
    const [since, until] = rangeWindow();
    if (full || until) {   // closed windows never need incremental refresh
      state.points = await fetchSoda(since, until);
    } else {
      const fresh = await fetchSoda(state.maxCreated || since);
      const seen = new Set(state.points.map(p => p.id));
      state.points = state.points.filter(p => p.t >= since).concat(fresh.filter(p => !seen.has(p.id)));
    }
    state.maxCreated = state.points.reduce((m, p) => (p.t > m ? p.t : m), since);
    state.lastFetch = new Date();
    setStatus(`${fmt(state.points.length)} requests loaded (deduplicated). Source: City of Chicago 311, v6vf-nfxy.`);
    renderAll();
  } catch (e) { setStatus(`Error: ${e.message}`); console.error(e); }
}
function setStatus(s) { $("status").textContent = s; }

const visible = () => state.points.filter(p => state.cats.has(p.k));

// ---------- geometry ----------
const R_MI = 3958.8;
function distMi(a, b, c, d) {
  const toR = Math.PI / 180, dLat = (c - a) * toR, dLon = (d - b) * toR;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a * toR) * Math.cos(c * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R_MI * Math.asin(Math.sqrt(h));
}
function countNear(lat, lon, pts = visible()) {
  const c = Object.fromEntries(CATS.map(x => [x.k, 0])); let all = 0;
  const dLat = state.radiusMi / 69, dLon = dLat / Math.cos(lat * Math.PI / 180);
  for (const p of pts) {
    if (Math.abs(p.lat - lat) > dLat || Math.abs(p.lon - lon) > dLon) continue;
    if (distMi(lat, lon, p.lat, p.lon) <= state.radiusMi) { c[p.k]++; all++; }
  }
  return { ...c, all };
}
function circle(lat, lon, mi, n = 48) {
  const ring = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * 2 * Math.PI;
    ring.push([lon + (mi / 69) * Math.cos(a) / Math.cos(lat * Math.PI / 180), lat + (mi / 69) * Math.sin(a)]);
  }
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } };
}

// ---------- map ----------
const map = new maplibregl.Map({
  container: "map", style: "https://tiles.openfreemap.org/styles/positron",   // OpenMapTiles schema, no key
  center: [-87.68, 41.84], zoom: 10.2,
});
// Controls are added once the module has run (NorthArrow is a class defined further down)
queueMicrotask(() => {
  map.addControl(new NorthArrow(), "top-right");
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "imperial", maxWidth: 120 }), "bottom-right");
});
map.on("error", e => console.warn("map:", e.error?.message || e));
new ResizeObserver(() => map.resize()).observe(document.getElementById("map"));
window.dashboard = { map, state };   // handy for debugging from the console
const empty = { type: "FeatureCollection", features: [] };

map.on("load", async () => {
  map.addSource("pts", { type: "geojson", data: empty });
  map.addSource("grid", { type: "geojson", data: empty });
  map.addSource("ca", { type: "geojson", data: empty, promoteId: "num" });
  map.addSource("rings", { type: "geojson", data: empty });
  map.addSource("probe", { type: "geojson", data: empty });

  map.addLayer({ id: "ca-fill", type: "fill", source: "ca", paint: {
    "fill-color": ["step", ["coalesce", ["feature-state", "cls"], 0], SEQ[0], 1, SEQ[1], 2, SEQ[2], 3, SEQ[3], 4, SEQ[4]],
    "fill-opacity": ["case", ["==", ["get", "mode"], 1], 0.75, 0] } });
  map.addLayer({ id: "grid", type: "fill", source: "grid", paint: {
    "fill-color": ["step", ["get", "cls"], SEQ[0], 1, SEQ[1], 2, SEQ[2], 3, SEQ[3], 4, SEQ[4]],
    "fill-opacity": 0.75 } });
  map.addSource("grid-lines", { type: "geojson", data: empty });
  map.addLayer({ id: "grid-lines", type: "line", source: "grid-lines",
    paint: { "line-color": "#6b6b6b", "line-width": 0.7, "line-opacity": 0.6 } });
  map.addLayer({ id: "heat", type: "heatmap", source: "pts", paint: {
    "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 9, 6, 14, 24],
    "heatmap-weight": ["coalesce", ["get", "w"], 1],
    "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 9, 0.6, 14, 1.5],
    "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(238,245,248,0)", 0.15, SEQ[1], 0.4, SEQ[2], 0.7, SEQ[3], 1, SEQ[4]],
    // fade the surface as streets come in so labels stay readable
    "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 11, 0.85, 14, 0.6, 15.5, 0.35] } });
  map.addLayer({ id: "pts", type: "circle", source: "pts", paint: {
    "circle-radius": ["interpolate", ["linear"], ["zoom"], 9, 2, 15, 5],
    "circle-color": ["match", ["get", "k"], ...CATS.flatMap(c => [c.k, c.color]), "#999"],
    "circle-stroke-color": "#fff", "circle-stroke-width": 0.5 } });
  map.addLayer({ id: "ca-line", type: "line", source: "ca", paint: {
    "line-color": ["case", ["boolean", ["feature-state", "sel"], false], "#000", "#9a9a9a"],
    "line-width": ["case", ["boolean", ["feature-state", "sel"], false], 2.5, 0.5] } });
  map.addLayer({ id: "rings", type: "line", source: "rings", paint: { "line-color": ["get", "color"], "line-width": 2 } });
  map.addSource("hot", { type: "geojson", data: empty });
  map.addLayer({ id: "hot-fill", type: "fill", source: "hot", layout: { visibility: "none" }, paint: {
    "fill-color": HOT_COLOR("all"), "fill-opacity": ["case", ["==", ["get", "cls_all"], 0], 0, 0.85],
    "fill-outline-color": "rgba(255,255,255,0.5)" } });
  map.on("click", "hot-fill", e => {
    if (state.mode !== "hotspots") return;
    const f = e.features[0].properties, k = state.hotKind;
    new maplibregl.Popup({ className: "peak-pop", maxWidth: "260px" }).setLngLat(e.lngLat).setHTML(hotText(f, k)).addTo(map);
  });
  map.addSource("peaks", { type: "geojson", data: empty });
  map.addLayer({ id: "peaks-dot", type: "circle", source: "peaks", paint: {
    "circle-radius": 10, "circle-color": ["case", ["==", ["get", "sig"], 1], MARKER_SIG, MARKER_NO],
    "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
  map.addLayer({ id: "peaks-label", type: "symbol", source: "peaks", layout: {
    "text-field": ["get", "rank"], "text-font": ["Noto Sans Bold"], "text-size": 12, "text-allow-overlap": true },
    paint: { "text-color": "#fff" } });
  // Peak details on hover instead of free text on the map (keeps street and area labels clear)
  const peakPop = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 14, className: "peak-pop", maxWidth: "260px" });
  map.on("mouseenter", "peaks-dot", e => {
    map.getCanvas().style.cursor = "pointer";
    peakPop.setLngLat(e.features[0].geometry.coordinates).setText(e.features[0].properties.note + ". Click to compare.").addTo(map);
  });
  map.on("mouseleave", "peaks-dot", () => { map.getCanvas().style.cursor = ""; peakPop.remove(); });
  map.on("click", "peaks-dot", e => {
    const p = state.peaks[+e.features[0].properties.rank - 1];
    if (p) { addPlace(`Point ${p.rank} · ${p.ca || "?"}`, p.lat, p.lon); }
  });
  map.addLayer({ id: "probe", type: "line", source: "probe", paint: { "line-color": "#000", "line-width": 1, "line-dasharray": [2, 2] } });
  addReferenceLayers();
  applyBaseTokens();

  try {
    const gj = await (await fetch(CA_GEOJSON)).json();
    gj.features.forEach(f => {
      const n = String(+(f.properties.area_numbe ?? f.properties.area_num_1));
      f.properties.num = n; f.properties.name = titleCase(f.properties.community);
      f.properties.areaSqMi = areaSqMi(f.geometry);
      state.caNames[n] = f.properties.name;
    });
    state.caGeo = gj; map.getSource("ca").setData(gj);
    renderAll();
  } catch (e) { console.warn("CA boundaries failed", e); }

  map.on("click", "ca-fill", e => { if (state.mode === "choropleth") selectCA(e.features[0].properties.num); });
  map.on("click", e => {
    if (e.originalEvent.shiftKey) { addPlace(`Point ${e.lngLat.lat.toFixed(3)}, ${e.lngLat.lng.toFixed(3)}`, e.lngLat.lat, e.lngLat.lng); return; }
    if (state.mode === "choropleth") return;
    const hit = map.queryRenderedFeatures(e.point, { layers: ["ca-line", "ca-fill"] })[0];
    if (hit) selectCA(hit.properties.num);
  });
  map.on("mousemove", onProbe);
  map.on("mouseout", clearProbe);
  map.on("moveend", () => { if (state.mode === "grid") renderMap(); });

  renderMap();
});

// Basemap in the design system's base- colours (light grey linework, pale water and parks)
function applyBaseTokens() {
  const set = (id, prop, v) => { if (map.getLayer(id)) map.setPaintProperty(id, prop, v); };
  set("background", "background-color", "#ffffff");
  set("water", "fill-color", "#e4eaf8");
  set("park", "fill-color", "#eef3e2");
  set("building", "fill-color", "#e2e2e2");
  set("landuse_residential", "fill-color", "#ffffff");
  set("landcover_wood", "fill-color", "#eef3e2");
  ["highway_minor", "highway_major_inner", "highway_major_subtle", "highway_motorway_inner", "highway_motorway_subtle"]
    .forEach(id => set(id, "line-color", "#e6e6e6"));
  // Hide basemap place labels that collide with community-area names
  ["label_other", "label_village", "label_town"].forEach(id => map.getLayer(id) && map.setLayoutProperty(id, "visibility", "none"));
}

// Reference layers that fade in with zoom: community areas → arterials → parks/schools → side streets.
function addReferenceLayers() {
  const font = ["Noto Sans Regular"], fontB = ["Noto Sans Bold"], fontI = ["Noto Sans Italic"];
  const halo = { "text-halo-color": "#fff", "text-halo-width": 1.4 };
  const fade = (a, b, c, d) => ["interpolate", ["linear"], ["zoom"], a, 0, b, 1, c, 1, d, 0];
  // Parks: light green fill from z10, names from z12.5 (larger parks first via rank)
  map.addLayer({ id: "ref-park", type: "fill", source: "openmaptiles", "source-layer": "park", minzoom: 10,
    paint: { "fill-color": "#dfe9cc", "fill-opacity": ["interpolate", ["linear"], ["zoom"], 10, 0.5, 14, 0.8] } }, "heat");
  map.addLayer({ id: "ref-park-label", type: "symbol", source: "openmaptiles", "source-layer": "poi", minzoom: 12.5,
    filter: ["all", ["==", ["get", "class"], "park"], ["<=", ["get", "rank"], ["step", ["zoom"], 12, 13.5, 25, 15, 99]]],
    layout: { "text-field": ["get", "name"], "text-font": fontI, "text-size": ["interpolate", ["linear"], ["zoom"], 12.5, 10, 16, 13], "text-max-width": 8 },
    paint: { "text-color": "#3f6b35", ...halo, "text-opacity": fade(12.5, 13, 22, 23) } });
  // Schools and colleges: dot + name from z13.5 (colleges) / z14.5 (schools)
  const school = ["match", ["get", "class"], ["school", "college"], true, false];
  map.addLayer({ id: "ref-school-dot", type: "circle", source: "openmaptiles", "source-layer": "poi", minzoom: 13.5, filter: school,
    paint: { "circle-radius": 3.5, "circle-color": "#4a7fb5", "circle-stroke-color": "#fff", "circle-stroke-width": 1,
      "circle-opacity": fade(13.5, 14.2, 22, 23), "circle-stroke-opacity": fade(13.5, 14.2, 22, 23) } });
  map.addLayer({ id: "ref-school-label", type: "symbol", source: "openmaptiles", "source-layer": "poi",
    minzoom: 14, filter: ["any", ["==", ["get", "class"], "college"], ["all", school, [">=", ["zoom"], 14.5]]],
    layout: { "text-field": ["get", "name"], "text-font": font, "text-size": 10.5, "text-offset": [0, 0.9], "text-anchor": "top", "text-max-width": 9 },
    paint: { "text-color": "#2f5a85", ...halo } });
  // Streets: arterials first (z11), then secondary (z12.5), tertiary (z13.5), local (z15)
  const streetMin = ["match", ["get", "class"], ["motorway", "trunk", "primary"], 11, "secondary", 12.5, "tertiary", 13.5, 15];
  map.addLayer({ id: "ref-street-label", type: "symbol", source: "openmaptiles", "source-layer": "transportation_name", minzoom: 11,
    filter: [">=", ["zoom"], streetMin],
    layout: { "symbol-placement": "line", "text-field": ["get", "name"], "text-font": font,
      "text-size": ["interpolate", ["linear"], ["zoom"], 11, 9.5, 16, 12.5], "text-letter-spacing": 0.03 },
    paint: { "text-color": ["match", ["get", "class"], ["motorway", "trunk", "primary"], "#333", "#666"], ...halo } });
  // Community area names: strongest at city scale, fade out once streets take over
  map.addLayer({ id: "ref-ca-label", type: "symbol", source: "ca", minzoom: 9.5, maxzoom: 15,
    layout: { "text-field": ["upcase", ["get", "name"]], "text-font": fontB, "text-letter-spacing": 0.08, "text-max-width": 7,
      "text-size": ["interpolate", ["linear"], ["zoom"], 9.5, 8.5, 12, 11, 14, 13] },
    paint: { "text-color": "#000", ...halo, "text-opacity": ["interpolate", ["linear"], ["zoom"], 9.5, 0.5, 11, 0.85, 13, 0.6, 14, 0] } });
  // Hide the basemap's own road names so streets aren't labelled twice
  ["highway-name-path", "highway-name-minor", "highway-name-major"].forEach(id => map.getLayer(id) && map.setLayoutProperty(id, "visibility", "none"));
}

// Spherical polygon area in square miles (Polygon or MultiPolygon, lon/lat)
function areaSqMi(g) {
  const ringArea = ring => {
    let s = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = ring[i], [x2, y2] = ring[i + 1], r = Math.PI / 180;
      s += (x2 - x1) * r * (2 + Math.sin(y1 * r) + Math.sin(y2 * r));
    }
    return Math.abs(s * R_MI * R_MI / 2);
  };
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  return polys.reduce((a, p) => a + ringArea(p[0]) - p.slice(1).reduce((h, x) => h + ringArea(x), 0), 0);
}
function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function homeCA(lat, lon) {
  for (const f of state.caGeo?.features || []) {
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    if (polys.some(p => inRing(lon, lat, p[0]) && !p.slice(1).some(h => inRing(lon, lat, h)))) return f.properties;
  }
  return null;
}

// Workbook method (Hotspot Validation sheet), generalised to any radius r:
//   LQ = n@r ÷ (CA_total / CA_area × π r²)       elevated vs the home CA's average density
//   tree decay = (tree@0.1 / tree@r) × (r/0.1)²  >1 = concentrated at the core (6.25 when r = 0.25)
//   water decay is a flag only (counts are tiny), never part of the verdict
function analyze(lat, lon) {
  const r = state.radiusMi, v = visible(), c = countNear(lat, lon, v);
  const core = { tree: 0, water: 0, all: 0 };
  for (const p of v) {
    if (Math.abs(p.lat - lat) > 0.0015 || Math.abs(p.lon - lon) > 0.002) continue;
    if (distMi(lat, lon, p.lat, p.lon) <= 0.1) { core.all++; core[p.k.startsWith("tree") ? "tree" : "water"]++; }
  }
  const tree = c.tree_emergency + c.tree_debris, water = c.water_basement + c.water_street;
  const ca = homeCA(lat, lon);
  let lq = null, expected = null, p = null;
  if (ca) {
    const caTotal = v.filter(p => p.ca === ca.num).length;
    expected = (caTotal / ca.areaSqMi) * Math.PI * r * r;
    lq = expected > 0 ? c.all / expected : null;
    // Significance: chance of seeing ≥ n calls in the circle if they were spread evenly over the CA (Poisson, λ = expected)
    p = expected > 0 ? poissonUpper(c.all, expected) : null;
  }
  const scale = (r / 0.1) ** 2;
  const treeDecay = r > 0.1 && tree ? (core.tree / tree) * scale : null;
  const waterDecay = r > 0.1 && water ? (core.water / water) * scale : null;
  let verdict = "–";
  if (lq !== null) {
    if (core.all === 0) verdict = "No calls at core";
    else if (lq >= 1.3 && treeDecay > 1) verdict = "Validated";
    else if (lq >= 1.3) verdict = "Above avg, spillover";
    else if (lq >= 1) verdict = "Near CA average";
    else verdict = "Below CA average";
  }
  return { c, core, tree, water, ca, lq, expected, p, treeDecay, waterDecay, verdict };
}
// P(X ≥ n) for X ~ Poisson(lam)
function poissonUpper(n, lam) {
  if (n <= 0) return 1;
  let term = Math.exp(-lam), cdf = term;
  for (let k = 1; k < n; k++) { term *= lam / k; cdf += term; }
  return Math.max(0, 1 - cdf);
}
const fmtP = p => (p === null ? "–" : p < 0.001 ? "<0.001" : p.toFixed(3));

// ---------- normalisation for heat + grid ----------
function rangeDays() {
  const [since, until] = rangeWindow();
  return Math.max(1 / 24, ((until || new Date()) - since) / 864e5);
}
function weightOf(p) {
  if (state.norm === "day") return 7 / rangeDays();                 // calls per week, comparable across ranges
  if (state.norm === "hh") { const h = hh(p.ca); return h ? 1000 / h : 0; }   // per 1k households of the home CA
  return 1;
}
const NORM_UNIT = { raw: "requests", day: "requests per week", hh: "requests per 1k households (home CA)" };
const fmtN = (x, d = 2) => (x === null || x === undefined || !isFinite(x) ? "–" : x.toFixed(d));

function titleCase(s = "") { return s.toLowerCase().replace(/\b\w/g, m => m.toUpperCase()); }

function renderMap() {
  if (!map.getSource("pts") || !map.getSource("probe")) return;
  const pts = scopedPoints();
  const show = (id, on) => map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  show("heat", state.mode === "heat"); show("pts", state.mode === "points" || (state.mode === "heat" && map.getZoom() > 14));
  show("grid", state.mode === "grid"); show("grid-lines", state.mode === "grid");
  show("hot-fill", state.mode === "hotspots");
  $("norm").classList.toggle("hidden", state.mode === "hotspots" || state.mode === "choropleth" || state.mode === "points");
  $("hotKind").classList.toggle("hidden", state.mode !== "hotspots");
  $("hotMethod").classList.toggle("hidden", state.mode !== "hotspots");
  if (state.mode === "hotspots") loadHot();
  // Heat weights: per-week keeps an absolute scale across ranges; per-household is rescaled to mean 1 so the
  // surface keeps its brightness but areas with fewer households weigh more.
  let wts = pts.map(weightOf);
  if (state.norm === "hh") { const mean = wts.reduce((a, b) => a + b, 0) / (wts.filter(Boolean).length || 1); wts = wts.map(w => w / (mean || 1)); }
  map.getSource("pts").setData({ type: "FeatureCollection", features: pts.map((p, i) => ({
    type: "Feature", properties: { k: p.k, w: wts[i] }, geometry: { type: "Point", coordinates: [p.lon, p.lat] } })) });

  if (state.mode === "grid") {   // raster-style aggregation into ~0.1 mi cells (finer when zoomed)
    const cell = map.getZoom() > 13 ? 0.0015 : map.getZoom() > 11.5 ? 0.003 : 0.006, bins = new Map();
    state.gridCell = cell;
    // Full lattice over the view (empty cells included) so the raster reads as a grid
    const b = map.getBounds(), lines = [];
    const x0 = Math.floor(b.getWest() / cell), x1 = Math.ceil(b.getEast() / cell);
    const y0 = Math.floor(b.getSouth() / cell), y1 = Math.ceil(b.getNorth() / cell);
    if ((x1 - x0) + (y1 - y0) < 1500) {
      for (let x = x0; x <= x1; x++) lines.push([[x * cell, y0 * cell], [x * cell, y1 * cell]]);
      for (let y = y0; y <= y1; y++) lines.push([[x0 * cell, y * cell], [x1 * cell, y * cell]]);
    }
    map.getSource("grid-lines").setData({ type: "Feature", properties: {}, geometry: { type: "MultiLineString", coordinates: lines } });
    for (const p of pts) {
      const key = `${Math.floor(p.lon / cell)},${Math.floor(p.lat / cell)}`;
      bins.set(key, (bins.get(key) || 0) + weightOf(p));
    }
    state.gridBreaks = quantileBreaks([...bins.values()]);
    map.getSource("grid").setData({ type: "FeatureCollection", features: [...bins].map(([key, n]) => {
      const [x, y] = key.split(",").map(Number), x0 = x * cell, y0 = y * cell;
      return { type: "Feature", properties: { cls: classOf(n, state.gridBreaks), n },
        geometry: { type: "Polygon", coordinates: [[[x0, y0], [x0 + cell, y0], [x0 + cell, y0 + cell], [x0, y0 + cell], [x0, y0]]] } };
    }) });
  }

  if (state.caGeo) {   // choropleth through feature-state
    const counts = caMetric();
    state.caBreaks = quantileBreaks(Object.values(counts));
    state.caGeo.features.forEach(f => {
      f.properties.mode = state.mode === "choropleth" ? 1 : 0;
      map.setFeatureState({ source: "ca", id: f.properties.num },
        { cls: classOf(counts[f.properties.num] || 0, state.caBreaks), sel: state.scope.kind === "ca" && state.scope.id === f.properties.num });
    });
    map.getSource("ca").setData(state.caGeo);
  }
  map.getSource("rings").setData({ type: "FeatureCollection",
    features: state.places.map(pl => ({ ...circle(pl.lat, pl.lon, state.radiusMi), properties: { color: pl.color } })) });
  renderPeaks(pts);
  renderLegend();
}

// Five quantile classes (design system: seq-1..seq-5, method named in the legend)
function quantileBreaks(vals) {
  const v = vals.filter(x => x > 0).sort((a, b) => a - b);
  if (!v.length) return [0, 0, 0, 0];
  return [0.2, 0.4, 0.6, 0.8].map(q => v[Math.min(v.length - 1, Math.floor(q * v.length))]);
}
const classOf = (x, br) => (x <= 0 ? 0 : br.filter(b => x > b).length);
function classRows(br, fmtV) {
  const lo = [0, ...br], hi = [...br, Infinity];
  return `<div class="classes">${SEQ.map((c, i) => `<i style="background:${c};border:1px solid #e8e8e8"></i><span>${
    i === 4 ? `over ${fmtV(lo[i])}` : i === 0 ? `up to ${fmtV(hi[0])}` : `${fmtV(lo[i])} to ${fmtV(hi[i])}`}</span>`).join("")}</div>`;
}

// ---------- peak markers: numbered reference points for the heat surface ----------
// Bin into ~0.25-mi cells, take the densest, re-centre on the mean of its calls, keep peaks ≥ 0.75 mi apart.
function findPeaks(pts, k = 3) {
  const cell = 0.0036, bins = new Map();
  for (const p of pts) {
    const key = `${Math.floor(p.lon / cell)},${Math.floor(p.lat / cell)}`;
    (bins.get(key) || bins.set(key, []).get(key)).push(p);
  }
  // Peaks are the maxima of many cells, so their p-values are Bonferroni-corrected by the number of cells searched.
  const tests = bins.size, out = [];
  for (const arr of [...bins.values()].sort((a, b) => b.length - a.length)) {
    if (out.length >= k || arr.length < 3) break;
    const lat = arr.reduce((s, p) => s + p.lat, 0) / arr.length, lon = arr.reduce((s, p) => s + p.lon, 0) / arr.length;
    if (out.some(o => distMi(o.lat, o.lon, lat, lon) < 0.75)) continue;
    const a = analyze(lat, lon), pAdj = a.p === null ? null : Math.min(1, a.p * tests);
    out.push({ rank: out.length + 1, lat, lon, n: a.c.all, ca: a.ca?.name, lq: a.lq, expected: a.expected,
      p: a.p, pAdj, tests, sig: pAdj !== null && pAdj < 0.05 && a.c.all >= 5, verdict: a.verdict });
  }
  return out;
}
function renderPeaks(pts) {
  const on = state.mode === "heat" || state.mode === "grid";
  state.peaks = on ? findPeaks(pts) : [];
  map.getSource("peaks").setData({ type: "FeatureCollection", features: state.peaks.map(p => ({
    type: "Feature", geometry: { type: "Point", coordinates: [p.lon, p.lat] },
    properties: { rank: String(p.rank), sig: p.sig ? 1 : 0,
      note: `Point ${p.rank} · ${p.ca || ""}: ${p.n} calls within ${state.radiusMi} mi vs ${fmtN(p.expected, 1)} expected · LQ ${fmtN(p.lq, 1)} · ${p.sig ? "relevant" : "not relevant"} (adj. p ${fmtP(p.pAdj)})` } })) });
  renderPeakTable();
}
function renderPeakTable() {
  const el = $("peakBody"); if (!el) return;
  el.innerHTML = state.peaks.length ? state.peaks.map(p => `<tr data-pk="${p.rank - 1}" title="Expected ${fmtN(p.expected, 1)} if spread evenly over ${p.ca}; raw p ${fmtP(p.p)}; ${p.tests} cells searched; workbook verdict: ${p.verdict}">
      <td><i class="badge" style="background:${p.sig ? MARKER_SIG : MARKER_NO}">${p.rank}</i>${p.ca || "?"}</td><td>${p.n}</td><td>${fmtN(p.expected, 1)}</td><td class="${p.lq >= 1.3 ? "hi" : ""}">${fmtN(p.lq, 1)}</td>
      <td>${fmtP(p.pAdj)}</td><td class="${p.sig ? "sig-yes" : "muted"}">${p.sig ? "Yes" : "No"}</td></tr>`).join("")
    : `<tr><td colspan="6" class="muted">Switch the map to Heatmap or Grid to find relevancy points.</td></tr>`;
}

// ---------- hot spots from QGIS (Getis-Ord Gi* on EB-smoothed rates per housing unit, June 2026) ----------
const HOT_CLASSES = [[3, "#c02625", "Hot spot, 99%"], [2, "#ec8136", "Hot spot, 95%"], [1, "#ebc84a", "Hot spot, 90%"],
  [-1, "#7fb1c9", "Cold spot, 90%"], [-2, "#3f84a8", "Cold spot, 95%"], [-3, "#145a6b", "Cold spot, 99%"]];
function HOT_COLOR(k) { return ["match", ["get", `cls_${k}`], ...HOT_CLASSES.flatMap(([v, c]) => [v, c]), "rgba(0,0,0,0)"]; }
const HOT_LABEL = { all: "all storm requests", tree: "tree requests", water: "water requests" };
const METHODS = {
  hu: { file: "data/hotspots_hu_june2026.geojson", title: "Gi* hot spots per housing unit",
    labels: ["Hot spot, 99%", "Hot spot, 95%", "Hot spot, 90%", "Cold spot, 90%", "Cold spot, 95%", "Cold spot, 99%"],
    note: "June 2026 · quarter-mile hexagons · per 1,000 housing units (2020 census), EB-smoothed · FDR-corrected." },
  base: { file: "data/storm_vs_baseline_june2026.geojson", title: "Rise vs a normal June",
    labels: ["Rose more than the city, 99%", "Rose more, 95%", "Rose more, 90%", "Rose less, 90%", "Rose less, 95%", "Rose less, 99%"],
    note: "June 2026 vs the same hexagon in June 2023–25 · binomial test against the citywide rise (×4.8 all, ×5.2 tree, ×2.1 water) · FDR-corrected. Each place is compared only with itself, so housing and canopy cancel out. Hexagons with fewer than 5 calls are not shown." },
};
const hotCache = {};
async function loadHot() {
  const m = state.hotMethod;
  try {
    hotCache[m] = hotCache[m] || await (await fetch(METHODS[m].file)).json();
    map.getSource("hot").setData(hotCache[m]);
  } catch (e) { setStatus("Hot spot layer failed to load"); }
}
function hotClasses() { return HOT_CLASSES.map(([v, c], i) => [v, c, METHODS[state.hotMethod].labels[i]]); }
function setHotKind(k) {
  state.hotKind = k;
  map.setPaintProperty("hot-fill", "fill-color", HOT_COLOR(k));
  map.setPaintProperty("hot-fill", "fill-opacity", ["case", ["==", ["get", `cls_${k}`], 0], 0, 0.85]);
  renderLegend();
}
function hotText(f, k) {
  const cls = hotClasses().find(([v]) => v === f[`cls_${k}`]);
  const head = `<b>${cls ? cls[2] : state.hotMethod === "base" ? "Not significantly different from the city" : "Not significant"}</b> · ${HOT_LABEL[k]}<br>`;
  if (state.hotMethod === "base")
    return head + `${f[`storm_${k}`]} calls in June 2026 vs ${f[`base3y_${k}`]} in June 2023–25 (about ${fmtN(f[`base3y_${k}`] / 3, 1)} a year)<br>`
      + `Rise ${fmtN(f[`rr_${k}`], 2)}× the city's rise`;
  return head + `${f[`n_${k}`]} calls · ${fmt(f.hu2020)} housing units<br>${fmtN(f[`eb_${k}`], 1)} per 1,000 units (smoothed)`;
}

// ---------- legend (changes with the map type) ----------
const RAMP = `linear-gradient(90deg,${SEQ.slice(1).join(",")})`;
function renderLegend() {
  const m = state.mode, n = scopedPoints().length;
  const cats = CATS.filter(c => state.cats.has(c.k));
  const extras = (state.places.length ? `<div class="sw"><i class="sq" style="background:none;border:2px solid ${state.places[0].color}"></i>Comparison radius (${state.radiusMi} mi)</div>` : "")
    + `<div class="sw"><i class="sq" style="background:#eef3e2;border:1px solid #c9d6b4"></i>Parks</div><div class="sw"><i style="background:#4a7fb5"></i>Schools (zoom in)</div>`;
  let body = "";
  if (m === "heat") body = `<b>Density · ${NORM_UNIT[state.norm]}</b><div class="ramp" style="background:${RAMP}"></div><div class="ends"><span>Low</span><span>High</span></div>
    <div class="note">${fmt(n)} requests · kernel density${state.norm === "day" ? " · fixed scale across time frames" : ""}</div>`;
  if (m === "grid") {
    const ft = Math.round((state.gridCell || 0.003) * 69 * 5280 / 10) * 10;
    body = `<b>Per cell · ${NORM_UNIT[state.norm]}</b>${classRows(state.gridBreaks || [0, 0, 0, 0], v => (state.norm === "raw" ? fmt(Math.round(v)) : fmtN(v, 1)))}
      <div class="note">Quantile classes · cell about ${ft.toLocaleString()} ft, finer as you zoom</div>`;
  }
  if (m === "hotspots") body = `<b>${METHODS[state.hotMethod].title} · ${HOT_LABEL[state.hotKind]}</b>`
    + hotClasses().map(([, c, l]) => `<div class="sw"><i class="sq" style="background:${c}"></i>${l}</div>`).join("")
    + (state.hotMethod === "base" && state.hotKind === "water" ? `<div class="note"><b style="display:inline;text-transform:none;letter-spacing:0">Water is too sparse per hexagon to test</b>: no hexagon passes. By community area, Mount Greenwood (3.2×) and Beverly (2.4×) rose more than the city.</div>` : "")
    + `<div class="note">${METHODS[state.hotMethod].note} Fixed analysis: ignores the time frame and category buttons.</div>`;
  if (m === "points") body = `<b>Request type</b>` + cats.map(c => `<div class="sw"><i style="background:${c.color}"></i>${c.label}</div>`).join("");
  if (m === "choropleth") {
    const label = { count: "Requests (live)", rate: "Per 1,000 households", june: "June 2026 requests", juneRate: "June 2026 per 1k HH", waterLQ: "Water LQ (share)" }[state.caSort];
    body = `<b>${label}</b>${classRows(state.caBreaks || [0, 0, 0, 0], v => (isRate() ? fmtN(v, 1) : fmt(Math.round(v))))}
      <div class="note">Quantile classes · measure set in Community areas</div>`;
  }
  if ((m === "heat" || m === "grid") && state.peaks?.length) body += `<div class="sep"><div class="sw"><i style="background:${MARKER_SIG};width:14px;height:14px"></i>Relevancy point, relevant</div>
    <div class="sw"><i style="background:${MARKER_NO};width:14px;height:14px"></i>Relevancy point, not relevant</div></div>`;
  $("legend").innerHTML = body + `<div class="sep">${extras}</div><div class="note">Source: City of Chicago 311 (v6vf-nfxy), 2026; OpenStreetMap.</div>`;
}

// North arrow that rotates with the map; click resets to north
class NorthArrow {
  onAdd(m) {
    this.el = document.createElement("div");
    this.el.className = "maplibregl-ctrl maplibregl-ctrl-group";
    this.el.innerHTML = `<div class="north" title="North (click to reset)"><svg width="16" height="22" viewBox="0 0 16 22"><path d="M8 0 L15 20 L8 15 L1 20 Z" fill="#000"/><path d="M8 0 L8 15 L1 20 Z" fill="#fff" stroke="#000" stroke-width=".8"/></svg>N</div>`;
    const svg = this.el.querySelector("svg");
    const sync = () => (svg.style.transform = `rotate(${-m.getBearing()}deg)`);
    m.on("rotate", sync);
    this.el.onclick = () => m.easeTo({ bearing: 0, pitch: 0 });
    return this.el;
  }
  onRemove() { this.el.remove(); }
}

// ---------- scope (the thing every panel correlates to) ----------
function scopedPoints() {
  const v = visible(), s = state.scope;
  if (s.kind === "ca") return v.filter(p => p.ca === s.id);
  if (s.kind === "place") return v.filter(p => distMi(s.lat, s.lon, p.lat, p.lon) <= state.radiusMi);
  return v;
}
function selectCA(num) {
  state.scope = { kind: "ca", id: num, name: state.caNames[num] || state.june?.areas[num]?.name || `CA ${num}` };
  renderAll();
  const f = state.caGeo?.features.find(x => x.properties.num === num);
  if (f) { const b = new maplibregl.LngLatBounds(); f.geometry.coordinates.flat(2).forEach(c => b.extend(c)); map.fitBounds(b, { padding: 60, maxZoom: 13.5 }); }
}
$("clearScope").onclick = () => { state.scope = { kind: "city", name: "Citywide" }; renderAll(); };

function statTiles(c, total) {
  return CATS.filter(x => state.cats.has(x.k)).map(x => `<div class="stat" style="--c:${x.color}"><b>${fmt(c[x.k] || 0)}</b><span>${x.label}</span></div>`).join("")
    + `<div class="stat" style="--c:#000"><b>${fmt(total)}</b><span>All</span></div>`;
}

let chart;
function renderScope() {
  const pts = scopedPoints(), c = {};
  pts.forEach(p => (c[p.k] = (c[p.k] || 0) + 1));
  $("scopeName").textContent = state.scope.name;
  $("scopeStats").innerHTML = statTiles(c, pts.length);
  const h = state.scope.kind === "ca" ? hh(state.scope.id) : state.scope.kind === "city" ? state.june?.city_households : 0;
  $("scopeRate").innerHTML = h ? `<b>${fmtRate(per1k(pts.length, h))}</b> per 1,000 households (${fmt(h)} households, CMAP 2026)`
    + (state.scope.kind === "ca" && state.june?.city_households ? ` · citywide ${fmtRate(per1k(visible().length, state.june.city_households))}` : "")
    : state.scope.kind === "place" ? lqLine(analyze(state.scope.lat, state.scope.lon)) : "";

  const [since, until] = rangeWindow(), end = until || new Date();
  const hourly = end - since <= 2 * 864e5, step = hourly ? 36e5 : 864e5;   // ≤ 2 days: hourly bars
  const nb = Math.max(1, Math.ceil((end - since) / step)), labels = [];
  for (let i = 0; i < nb; i++) { const d = new Date(+since + i * step); labels.push(hourly ? `${d.getHours()}:00` : `${d.getMonth() + 1}/${d.getDate()}`); }
  const series = CATS.filter(x => state.cats.has(x.k)).map(x => ({ label: x.label, backgroundColor: x.color, data: new Array(nb).fill(0), k: x.k }));
  const idx = Object.fromEntries(series.map((s, i) => [s.k, i]));
  pts.forEach(p => { const b = Math.floor((p.t - since) / step); if (b >= 0 && b < nb) series[idx[p.k]].data[b]++; });

  if (chart) { chart.data.labels = labels; chart.data.datasets = series; chart.update("none"); return; }
  chart = new Chart($("trend"), { type: "bar", data: { labels, datasets: series },
    options: { animation: false, responsive: true, plugins: { legend: { display: false } },
      scales: { x: { stacked: true, grid: { display: false }, ticks: { maxTicksLimit: 10, font: { size: 10 } } },
        y: { stacked: true, ticks: { font: { size: 10 } } } } } });
}

// ---------- community areas ----------
function caCounts() { const o = {}; visible().forEach(p => p.ca && (o[p.ca] = (o[p.ca] || 0) + 1)); return o; }
function juneTotals() {
  const o = {}; if (!state.june) return o;
  for (const [n, a] of Object.entries(state.june.areas))
    o[n] = Object.entries(a.daily).filter(([k]) => state.cats.has(k)).reduce((s, [, arr]) => s + arr.reduce((x, y) => x + y, 0), 0);
  return o;
}
const hh = n => state.june?.areas[n]?.households || 0;
const per1k = (count, h) => (h ? (count / h) * 1000 : 0);
const fmtRate = r => r.toFixed(r < 10 ? 2 : 1);
// The metric the CA list and the choropleth both use, keyed by CA number
function caMetric() {
  const live = caCounts(), june = juneTotals(), o = {};
  let wq;
  if (state.caSort === "waterLQ") {   // share LQ: (water/all in CA) ÷ (water/all citywide)
    const w = {}, v = visible(); let cw = 0;
    v.forEach(p => { if (p.k.startsWith("water")) { cw++; if (p.ca) w[p.ca] = (w[p.ca] || 0) + 1; } });
    const cityShare = v.length ? cw / v.length : 0;
    wq = n => (live[n] >= 5 && cityShare ? (w[n] || 0) / live[n] / cityShare : 0);   // <5 calls: too few to read
  }
  for (const n of Object.keys(state.june?.areas || live)) {
    o[n] = state.caSort === "waterLQ" ? wq(n)
      : { count: live[n] || 0, rate: per1k(live[n] || 0, hh(n)), june: june[n] || 0, juneRate: per1k(june[n] || 0, hh(n)) }[state.caSort];
  }
  return o;
}
const isRate = () => ["rate", "juneRate", "waterLQ"].includes(state.caSort);

function renderCAList() {
  const live = caCounts(), june = juneTotals(), key = caMetric();
  const nums = Object.keys(state.caNames).length ? Object.keys(state.caNames) : Object.keys(june);
  const rows = nums.map(n => ({ n, name: state.caNames[n] || state.june?.areas[n]?.name || n, v: key[n] || 0, live: live[n] || 0, june: june[n] || 0 }))
    .sort((a, b) => b.v - a.v);
  const max = Math.max(1, rows[0]?.v || 1);
  const cityHH = state.june?.city_households;
  const cityLive = visible().length, cityJune = Object.values(june).reduce((a, b) => a + b, 0);
  $("caMetricNote").textContent = {
    count: "Live count for the selected range.",
    rate: `Live requests per 1,000 households. Citywide: ${fmtRate(per1k(cityLive, cityHH))}.`,
    june: "June 2026 storm baseline from the workbook (deduped).",
    juneRate: `June 2026 per 1,000 households. Citywide: ${fmtRate(per1k(cityJune, cityHH))}.`,
    waterLQ: "Water share of each area's live calls ÷ citywide water share. Above 1 = flooding makes up more of the area's calls than it does citywide. Areas with fewer than 5 calls show 0.",
  }[state.caSort] + (isRate() && state.caSort !== "waterLQ" ? " Households: CMAP Community Data Snapshots 2026 (ACS 5-yr)." : "");
  $("caList").innerHTML = rows.map((r, i) => `<li data-n="${r.n}" class="${state.scope.kind === "ca" && state.scope.id === r.n ? "sel" : ""}" title="Live ${fmt(r.live)} · June 2026 ${fmt(r.june)} · ${fmt(hh(r.n))} households">
    <span class="muted">${i + 1}</span><span class="nm">${r.name}<div class="bar" style="width:${(r.v / max) * 100}%"></div></span>
    <span class="n">${isRate() ? fmtRate(r.v) : fmt(r.v)}</span><span class="muted">${r.n}</span></li>`).join("");
}
$("caList").onclick = e => { const li = e.target.closest("li"); if (li) selectCA(li.dataset.n); };
$("caSort").onclick = e => {
  const b = e.target.closest("button"); if (!b) return;
  state.caSort = b.dataset.k; press($("caSort"), b);
  renderCAList(); renderMap(); renderScope();
};

// ---------- address comparison ----------
// Comparison places: map-marker-2 orange, project colours (fills only), accent
const PALETTE = ["#ec8136", "#186460", "#c56825", "#e07484", "#2b7a76", "#4d4d4d"];
function addPlace(name, lat, lon) {
  state.places.push({ name, lat, lon, color: PALETTE[state.places.length % PALETTE.length] });
  renderCompare(); renderMap();
}
async function geocode(q) {   // OpenStreetMap Nominatim, bounded to Chicago; 1 request per click
  const p = new URLSearchParams({ q: /chicago/i.test(q) ? q : `${q}, Chicago, IL`, format: "json", limit: 1,
    viewbox: "-87.95,42.03,-87.52,41.64", bounded: 1 });
  const r = await (await fetch(`https://nominatim.openstreetmap.org/search?${p}`)).json();
  if (!r.length) throw new Error("Address not found");
  return { lat: +r[0].lat, lon: +r[0].lon };
}
$("addAddr").onclick = async () => {
  const q = $("addr").value.trim(); if (!q) return;
  try { const g = await geocode(q); addPlace(q, g.lat, g.lon); $("addr").value = ""; map.flyTo({ center: [g.lon, g.lat], zoom: 14 }); }
  catch (e) { setStatus(e.message); }
};
$("addr").onkeydown = e => { if (e.key === "Enter") $("addAddr").click(); };
$("addCenter").onclick = () => { const c = map.getCenter(); addPlace(`Map centre ${c.lat.toFixed(3)}, ${c.lng.toFixed(3)}`, c.lat, c.lng); };
$("radius").oninput = e => {
  state.radiusMi = +e.target.value; $("radiusVal").textContent = `${state.radiusMi} mi`;
  renderCompare(); renderMap(); if (state.scope.kind === "place") { renderScope(); }
};
// ---------- reference point: compare two equal circles ----------
// Same radius ⇒ same area, so under "no difference" each call in the two circles is equally likely to fall in
// either one: nA ~ Binomial(nA + nB, 0.5). Two-sided exact test. The ratio still carries every difference
// between the places (households, canopy, sewers, call habits); it describes, it does not explain.
function logChoose(n, k) { let s = 0; for (let i = 1; i <= k; i++) s += Math.log((n - k + i) / i); return s; }
function binomTwoSided(a, n) {
  if (n === 0) return 1;
  const pmf = k => Math.exp(logChoose(n, Math.min(k, n - k)) - n * Math.LN2);
  const pa = pmf(a); let p = 0;
  for (let k = 0; k <= n; k++) { const q = pmf(k); if (q <= pa * (1 + 1e-9)) p += q; }
  return Math.min(1, p);
}
function vsRef(nA) {
  const ref = state.places[state.refIdx]; if (!ref) return null;
  const nB = countNear(ref.lat, ref.lon).all;
  return { ratio: nB ? nA / nB : null, nB, p: binomTwoSided(nA, nA + nB) };
}
const fmtRatio = r => (r.ratio === null ? "no ref calls" : `${r.ratio.toFixed(r.ratio < 10 ? 2 : 0)}×`);

function renderCompare() {
  if (state.refIdx != null && !state.places[state.refIdx]) state.refIdx = null;
  $("cmpBody").innerHTML = state.places.map((pl, i) => {
    const a = analyze(pl.lat, pl.lon), c = a.c;
    const sel = state.scope.kind === "place" && state.scope.i === i, isRef = state.refIdx === i;
    const r = !isRef ? vsRef(c.all) : null;
    const refCell = isRef ? `<td class="hi">Reference</td>`
      : r ? `<td class="${r.p < 0.05 ? "hi" : "muted"}" title="${c.all} vs ${r.nB} calls in equal circles; two-sided binomial p ${fmtP(r.p)}">${fmtRatio(r)}${r.p < 0.05 ? "" : " (n.s.)"}</td>`
      : `<td class="muted">–</td>`;
    return `<tr data-i="${i}" class="${sel ? "sel" : ""}" title="${pl.name} · ${a.ca?.name || "outside Chicago"} · tree decay ${fmtN(a.treeDecay)} · water decay ${fmtN(a.waterDecay)} (flag only) · ${a.verdict}"><td><i class="badge" style="background:${pl.color}">${i + 1}</i>${pl.name}</td>
      ${CATS.map(x => `<td>${state.cats.has(x.k) ? fmt(c[x.k]) : "–"}</td>`).join("")}<td><b>${fmt(c.all)}</b></td>
      <td class="${a.lq >= 1.3 ? "hi" : ""}">${fmtN(a.lq)}</td>${refCell}
      <td style="white-space:nowrap">${isRef ? `<button class="link" data-ref="">Clear ref</button>` : `<button class="link" data-ref="${i}" aria-label="Use ${pl.name} as the reference">Set ref</button>`}
        <button class="link" data-del="${i}" aria-label="Remove ${pl.name}">Remove</button></td></tr>`;
  }).join("") || `<tr><td colspan="9" class="muted">Add an address, the map center, or shift-click the map.</td></tr>`;
}
$("cmpBody").onclick = e => {
  if (e.target.dataset.ref !== undefined) {
    state.refIdx = e.target.dataset.ref === "" ? null : +e.target.dataset.ref;
    renderCompare(); return;
  }
  if (e.target.dataset.del !== undefined) {
    const d = +e.target.dataset.del;
    state.places.splice(d, 1);
    if (state.refIdx === d) state.refIdx = null; else if (state.refIdx > d) state.refIdx--;
    if (state.scope.kind === "place") state.scope = { kind: "city", name: "Citywide" };
    renderAll(); return;
  }
  const tr = e.target.closest("tr[data-i]"); if (!tr) return;
  const pl = state.places[+tr.dataset.i];
  state.scope = { kind: "place", i: +tr.dataset.i, lat: pl.lat, lon: pl.lon, name: `${pl.name} (${state.radiusMi} mi)` };
  map.flyTo({ center: [pl.lon, pl.lat], zoom: 14 }); renderAll();
};

function lqLine(a) {
  if (!a.ca) return "Outside Chicago community areas.";
  return `In <b>${a.ca.name}</b> · LQ <b>${fmtN(a.lq)}</b> (${a.c.all} vs ${fmtN(a.expected, 1)} expected, p ${fmtP(a.p)}) · ${a.core.all} calls within 0.1 mi · tree decay ${fmtN(a.treeDecay)}`
    + ` · water decay ${fmtN(a.waterDecay)} (flag, n=${a.water}) · <b>${a.verdict}</b>`;
}

// ---------- cursor probe ----------
let probeRaf = 0;
// Heat / grid / points: radius probe with LQ. Community areas: hover the area itself (a radius means nothing there).
function setProbeMode() {
  const ca = state.mode === "choropleth", hx = state.mode === "hotspots", on = $("probeOn").checked;
  $("probeTitle").textContent = ca ? "Area under cursor" : hx ? "Hexagon under cursor" : "Cursor probe";
  $("probeHint").textContent = !on ? "Turned off. Tick “Follow cursor” to probe the map."
    : hx ? (state.hotMethod === "base" ? "Hover a hexagon for its June 2026 calls and how much it rose against its own normal June, compared with the city's rise. Click it for details."
      : "Hover a hexagon for its June 2026 calls, housing units and smoothed rate for all, tree and water. Click it for details.")
    : ca ? "Hover a community area to read its live count, household rate, water LQ and June 2026 total. Click to make it the scope."
    : "Hover the map: counts within the radius follow the pointer. Shift-click to pin it to the comparison.";
  clearProbe();
}
function clearProbe() {
  $("probe").classList.add("hidden"); $("probeStats").innerHTML = ""; $("probeLQ").innerHTML = "";
  map.getSource("probe")?.setData(empty);
}
function probeArea(e) {
  const f = map.queryRenderedFeatures(e.point, { layers: ["ca-fill"] })[0];
  map.getCanvas().style.cursor = f ? "pointer" : "";
  if (!f) return clearProbe();
  const n = f.properties.num, pts = visible().filter(p => p.ca === n), c = {};
  pts.forEach(p => (c[p.k] = (c[p.k] || 0) + 1));
  const sortWas = state.caSort; state.caSort = "waterLQ"; const wlq = caMetric()[n]; state.caSort = sortWas;
  const june = juneTotals()[n] || 0;
  $("probeStats").innerHTML = statTiles(c, pts.length);
  $("probeLQ").innerHTML = `<b>${f.properties.name}</b> (${n}) · ${fmtRate(per1k(pts.length, hh(n)))} per 1k households · water LQ ${wlq ? fmtN(wlq) : "– (under 5 calls)"} · June 2026: ${fmt(june)}`;
  const tip = $("probe"); tip.classList.remove("hidden");
  tip.style.left = `${e.point.x}px`; tip.style.top = `${e.point.y}px`;
  tip.textContent = `${f.properties.name} · ${fmt(pts.length)} requests`;
}
function probeHex(e) {
  const f = map.queryRenderedFeatures(e.point, { layers: ["hot-fill"] })[0];
  if (!f) return clearProbe();
  const p = f.properties;
  const base = state.hotMethod === "base";
  $("probeStats").innerHTML = ["all", "tree", "water"].map(k => {
    const cls = HOT_CLASSES.find(([v]) => v === p[`cls_${k}`]);
    return `<div class="stat" style="--c:${cls ? cls[1] : "#e8e8e8"}"><b>${base ? p[`storm_${k}`] : p[`n_${k}`]}</b><span>${k} · ${
      base ? `${fmtN(p[`rr_${k}`], 2)}× city rise` : `${fmtN(p[`eb_${k}`], 1)}/1k units`}</span></div>`;
  }).join("");
  $("probeLQ").innerHTML = hotText(p, state.hotKind);
  const tip = $("probe"); tip.classList.remove("hidden");
  tip.style.left = `${e.point.x}px`; tip.style.top = `${e.point.y}px`;
  const cls = hotClasses().find(([v]) => v === p[`cls_${state.hotKind}`]);
  tip.textContent = base ? `${cls ? cls[2] : "Not significantly different from the city"} · ${fmtN(p[`rr_${state.hotKind}`], 2)}× city rise`
    : `${cls ? cls[2] : "Not significant"} · ${fmt(p.hu2020)} housing units`;
}
function onProbe(e) {
  cancelAnimationFrame(probeRaf);
  if (!$("probeOn").checked) return;
  probeRaf = requestAnimationFrame(() => {
    if (state.mode === "choropleth") return probeArea(e);
    if (state.mode === "hotspots") return probeHex(e);
    const { lat, lng } = e.lngLat, a = analyze(lat, lng), c = a.c;
    $("probeLQ").innerHTML = lqLine(a);
    map.getSource("probe").setData(circle(lat, lng, state.radiusMi));
    const tip = $("probe"); tip.classList.remove("hidden");
    tip.style.left = `${e.point.x}px`; tip.style.top = `${e.point.y}px`;
    const r = vsRef(c.all);
    tip.textContent = `${fmt(c.all)} within ${state.radiusMi} mi · LQ ${fmtN(a.lq)}${a.ca ? " · " + a.ca.name : ""}`
      + (r ? ` · ${fmtRatio(r)} ref${r.p < 0.05 ? "" : " (n.s.)"}` : "");
    $("probeStats").innerHTML = statTiles(c, c.all);
  });
}

// ---------- controls ----------
$("cats").innerHTML = CATS.map(c => `<label><input type="checkbox" value="${c.k}" checked><i style="background:${c.color}"></i>${c.label}</label>`).join("");
$("cats").onchange = e => { e.target.checked ? state.cats.add(e.target.value) : state.cats.delete(e.target.value); renderAll(); };
function reloadRange() { state.maxCreated = null; if (chart) { chart.destroy(); chart = null; } load(true); }
const isoDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
$("from").max = $("to").max = isoDay(new Date());
$("range").onclick = e => {
  const b = e.target.closest("button[data-r]"); if (!b) return;
  press($("range"), b);
  state.range = b.dataset.r;
  const custom = state.range === "custom";
  $("customDates").classList.toggle("hidden", !custom);
  if (custom) {   // start the picker on whatever window was showing
    if (!$("from").value) { $("to").value = isoDay(new Date()); $("from").value = isoDay(new Date(Date.now() - 6 * 864e5)); }
    applyCustom();
  } else reloadRange();
};
function applyCustom() {
  const f = $("from").value, t = $("to").value;
  if (!f || !t) return;
  if (f > t) { setStatus("“From” must be on or before “To”."); return; }
  const days = (new Date(t) - new Date(f)) / 864e5 + 1;
  if (days > 400) { setStatus("Pick a window of about a year or less: the live API gets slow beyond that."); return; }
  state.from = f; state.to = t; reloadRange();
}
$("from").onchange = $("to").onchange = applyCustom;
$("customDates").onclick = e => {
  const b = e.target.closest("button[data-q]"); if (!b) return;
  const now = new Date(), q = b.dataset.q;
  const start = q === "ytd" ? new Date(now.getFullYear(), 0, 1) : q === "mtd" ? new Date(now.getFullYear(), now.getMonth(), 1) : new Date(now - +q * 864e5);
  $("from").value = isoDay(start); $("to").value = isoDay(now); applyCustom();
};
function setMode(m) {
  state.mode = m;
  press($("mapMode"), $("mapMode").querySelector(`[data-m="${m}"]`));
  setProbeMode(); renderMap();
}
$("mapMode").onclick = e => { const b = e.target.closest("button"); if (b) setMode(b.dataset.m); };
// Keys 1–4 switch map type (ignored while typing in a field)
document.addEventListener("keydown", e => {
  if (e.target.matches("input,select,textarea") || e.ctrlKey || e.metaKey) return;
  const m = { 1: "heat", 2: "grid", 3: "points", 4: "choropleth", 5: "hotspots" }[e.key];
  if (m) setMode(m);
});
[...$("mapMode").children].forEach((b, i) => (b.title = `Press ${i + 1}`));
$("probeOn").onchange = setProbeMode;
$("hotKind").onclick = e => { const b = e.target.closest("button[data-h]"); if (!b) return; press($("hotKind"), b); setHotKind(b.dataset.h); };
$("hotMethod").onclick = async e => {
  const b = e.target.closest("button[data-hm]"); if (!b) return;
  press($("hotMethod"), b); state.hotMethod = b.dataset.hm;
  await loadHot(); setHotKind(state.hotKind); setProbeMode();
};
$("refresh").onclick = () => load(false);
$("norm").onclick = e => {
  const b = e.target.closest("button"); if (!b) return;
  state.norm = b.dataset.n; press($("norm"), b); renderMap();
};
$("peakBody").onclick = e => {
  const tr = e.target.closest("tr[data-pk]"); if (!tr) return;
  const p = state.peaks[+tr.dataset.pk];
  map.flyTo({ center: [p.lon, p.lat], zoom: 14.5 });
};

function renderAll() {
  $("liveCount").textContent = fmt(visible().length);
  $("liveTime").textContent = state.lastFetch ? state.lastFetch.toLocaleTimeString() : "–";
  renderMap(); renderScope(); renderCAList(); renderCompare();
}

// Data loads independently of the map, so panels fill even before the basemap finishes.
fetch("data/june2026.json").then(r => r.json()).then(j => { state.june = j; renderCAList(); renderScope(); }).catch(() => {});
setProbeMode();
// Chart text follows the theme (ink-body), so it reads in Page and Night
Chart.defaults.color = getComputedStyle(document.documentElement).getPropertyValue("--ink-body").trim() || "#656565";
Chart.defaults.font.family = "Public Sans";
$("legendToggle").onclick = () => {
  const open = $("legend").classList.toggle("open");
  $("legendToggle").setAttribute("aria-expanded", String(open));
};
load(true);
setInterval(() => load(false), REFRESH_MS);
