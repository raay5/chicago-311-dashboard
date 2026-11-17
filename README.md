# Chicago 311 Rain & Tree dashboard

Live dashboard of four storm-related 311 categories: Tree Emergency, Tree Debris Clean-Up Request, Water in Basement and Water On Street. It pulls from the City of Chicago Socrata API (dataset `v6vf-nfxy`, `duplicate=false`) and needs no API key. It refreshes every 5 minutes.

## Run
```
python -m http.server 8311
```
Then open http://localhost:8311/. The app uses ES modules and fetch, so it has to be served over HTTP. Opening it as a file won't work.

## Components (all share one state object in `js/app.js`)
- **Active scope**: stat tiles and a daily or hourly stacked trend for whatever is selected: citywide, a community area or a comparison place.
- **Community areas**: ranked list (live count, or the June 2026 storm baseline), map outlines, and a choropleth map mode. Click a row or an area to set the scope.
- **Map modes**: heatmap, grid (raster-style binning that gets finer as you zoom), points, choropleth.
- **Area comparison**: add an address (geocoded with OSM Nominatim, limited to Chicago) or the map center. Shift-click the map to pin a point. The radius slider applies to all places. Click a row to make it the scope.
- **Cursor probe**: live counts within the radius of the mouse pointer.

## Data
- `data/june2026.json` comes from `Chicago311AnalysisJune2026byCACatDate_7 1.xlsx` (the "Daily by CA & Category" sheet). Rebuild it with `python scripts/extract_june.py <xlsx>`.
- Households per community area come from CMAP Community Data Snapshots 2026 (`CCA_2026`, `TOT_HH`, ACS 5-year), taken from the workbook's per-capita sheet. Rates are requests per 1,000 households. "June /1k HH" covers all of June 1–30, while the workbook's rates cover 6/7–6/24 only, so the two won't match exactly.
- **Location quotient** follows the workbook's Hotspot Validation method. LQ = calls within r ÷ (home community area's calls per sq mi × πr²). Tree decay = (tree calls within 0.1 mi ÷ tree calls within r) × (r/0.1)². Water decay is shown as a flag only. Verdict: LQ ≥ 1.3 and tree decay > 1 means validated. Community area areas are computed from the boundary polygons. "Water LQ" is a share LQ: the area's water share ÷ the citywide water share, needing at least 5 calls.
- **Style:** follows the Ray Liao Portfolio design system v5 (Rate Field repo, `design-system/`): Public Sans, square panels, pill tag switches with `aria-pressed`, the `seq-1`–`seq-5` ramp with five quantile classes, `base-` basemap colours, `map-marker-1` for relevant points, captions that end with the source and year, and a Night theme. The West Side hotspot table was removed from the page; its data stays in `data/june2026.json`.
- The basemap is OpenFreeMap (OpenMapTiles). Labels appear by zoom: community areas from z9.5 (fading out by z14.5), arterials z11, secondary z12.5, tertiary z13.5, local z15, parks z12.5+ (larger first), colleges z14, schools z14.5.
- **Layout:** the left column holds the active scope and the cursor probe, the map sits in the center, and the right column holds community areas, area comparison and hotspots. Below 1250 px wide, the right column moves under the map.
- **Map types:** pick one with the buttons on the map or press keys 1–4. Every type has its own legend. The map also has a north arrow (click it to reset rotation) and an imperial scale bar.
- **Grid** draws the full cell lattice over the view, and the cell size is shown in the legend.
- **Relevancy points** (heatmap and grid): the 3 densest ~0.25-mi spots, at least 0.75 mi apart. Each is labelled with its call count within the radius, its community area and its LQ. Click a peak to add it to the comparison.
- **Normalize** (heat and grid): Count; Per week (×7/days, a fixed scale that's comparable across ranges); Per 1k HH (each call weighted by 1,000 ÷ households in its community area). Assumption: this uses one household count per community area, not a block-level population surface.
- **Relevancy-point significance:** each peak's LQ uses the same formula as the West Side hotspots. The test is a Poisson P(X ≥ observed | expected from the home CA's density), Bonferroni-corrected by the number of 0.25-mi cells searched, and it also needs at least 5 calls. Caveat: calls cluster more than Poisson assumes (overdispersion), so the test leans toward calling things significant.
- **Cursor probe:** in the community-area view it shows the area under the cursor instead of a radius. It can be turned off.
- Community area boundaries are fetched live from `igwz-8jzy`.

## QGIS project (`qgis/chicago_311.qgz`)
Uses EPSG:3435. All layers are in `qgis/chicago_311.gpkg`, built from `data/raw/` (`scripts/fetch_311_geojson.py`).
- **Getis-Ord Gi\*** (`gi_star_june2026`): 4,618 hexagons, 1,320 ft (quarter-mile) spacing, clipped to the city, empty cells included. Neighbours are a fixed distance band of 1.2 × spacing (the cell itself plus the six adjacent cells). Run separately for all requests, tree requests and water requests. p-values are two-sided and Benjamini–Hochberg FDR-corrected; classes are ±3/±2/±1 = 99/95/90 %. Colours: map-marker-1/2/3 for hot spots, seq for cold spots.
- **Caveat:** Gi\* on raw counts finds where calls cluster, which partly reflects where trees and households are. It does not account for exposure.
- **Gi\* per housing unit** (`gi_star_hu_june2026`): 2020 Census block housing units (`HU100`, from TIGERweb with no key; `scripts/fetch_block_housing.py`) are added up per hexagon by each block's internal point. The city total is 1,262,619 units, which matches the 2020 census. Rates are smoothed with Marshall global empirical Bayes, and Gi\* runs on the smoothed rates. Hexagons with no housing units are excluded, leaving 3,552 of 4,618. Assumption: housing units stand in for households and include vacant units, so rates come out low where vacancy is high.
- **Storm compared with a normal June** (`storm_vs_baseline_june2026`): each hexagon's June 2026 calls are compared with its own June 2023–2025 total (`scripts/fetch_311_geojson.py --baseline`). Model: storm ~ Binomial(storm + baseline, citywide storm share). Two-sided test, FDR-corrected, and a hexagon needs at least 5 calls to be tested. `rr_*` = how much this hexagon rose ÷ how much the city rose. Housing, canopy and how willing people are to call 311 cancel out, because each place is compared only with itself. Water calls are too sparse per hexagon (only 187 testable), so water was also tested by community area.
- **Tree calls per canopy acre** (`gi_star_canopy_tree_june2026`): canopy comes from NLCD Tree Canopy Cover 2021 (30 m, MRLC WCS, Chicago clip in `data/raw/`). The source raster flags 0 as nodata, but 0 means "no canopy", so the clean copy uses 255 as nodata. Mean canopy per hexagon × hexagon area gives canopy acres. Rates are EB-smoothed and run through Gi\*, FDR-corrected, for hexagons with at least 0.5 acres of canopy. Caveat: 30 m pixels undercount street trees (15.6 % citywide here, against about 19 % in the 1 m CRTI data). The Field Museum TreeTops service covers DuPage County only, not Chicago.
- The hot spot layer in the web app (`data/hotspots_hu_june2026.geojson`) is exported from `gi_star_hu_june2026`.
- In the web app, the **Hot spots** map type has two methods: "Per housing unit" (`hotspots_hu_june2026.geojson`) and "Rise vs normal June" (`storm_vs_baseline_june2026.geojson`, only the hexagons with at least 5 calls).
