"""Extract the June 2026 storm workbook into data/june2026.json (run: python scripts/extract_june.py <xlsx>)."""
import json, sys, openpyxl
wb = openpyxl.load_workbook(sys.argv[1], read_only=True, data_only=True)
ws = wb["Daily by CA & Category"]
rows = list(ws.iter_rows(values_only=True))
hdr = rows[2]
days = [str(h) for h in hdr[3:] if h and "/" in str(h)][:30]
cat = {"Tree Emergency": "tree_emergency", "Tree Debris": "tree_debris",
       "Water in Basement": "water_basement", "Water on Street": "water_street"}
out = {}
for r in rows[3:]:
    if not isinstance(r[0], (int, float)) or r[2] not in cat: continue
    ca = str(int(r[0]))
    d = out.setdefault(ca, {"name": r[1], "daily": {}})
    d["daily"][cat[r[2]]] = [int(v or 0) for v in r[3:3 + len(days)]]
# Households (CMAP Community Data Snapshots 2026, CCA_2026 TOT_HH), from the all-CA block of the per-capita sheet
norm = lambda s: str(s).strip().lower().replace("the loop", "loop").replace("’", "'")
by_name = {norm(v["name"]): k for k, v in out.items()}
pc = list(wb["Per-Capita (West Side)"].iter_rows(values_only=True))
start = next(i for i, r in enumerate(pc) if r[0] and str(r[0]).startswith("CITYWIDE"))
city_hh = pc[start][19]
for r in pc[start + 1:]:
    if not r[0] or not isinstance(r[19], (int, float)): continue
    k = by_name.get(norm(r[0]))
    if k: out[k]["households"] = int(r[19])
    else: print("unmatched:", r[0])
# West Side hotspot validation (6/7-6/24, 0.25-mi buffers): QGIS group5 results, no coordinates in the workbook
hs = []
for r in wb["Hotspot Validation"].iter_rows(values_only=True):
    if r[0] and isinstance(r[2], (int, float)) and isinstance(r[10], (int, float)):
        hs.append({"name": r[0], "ca": r[1], "te": r[2], "td": r[3], "wb": r[4], "ws": r[5], "n25": r[6], "n10": r[7],
                   "tree_decay": round(r[8], 2) if isinstance(r[8], (int, float)) else None,
                   "water_flag": str(r[9]).replace("—", "-").strip(), "lq": round(r[10], 2), "verdict": str(r[11]).replace("—", "-")})
print(len(hs), "hotspots")
print(sum("households" in v for v in out.values()), "areas with households")
json.dump({"source": "Chicago 311 (v6vf-nfxy), pulled 6/30/2026, deduped; 4 storm categories",
           "households_source": "CMAP Community Data Snapshots 2026, CCA_2026, TOT_HH (ACS 5-year)",
           "city_households": int(city_hh), "days": days, "areas": out, "hotspots": hs}, open("data/june2026.json", "w"), separators=(",", ":"))
print(len(out), "areas,", len(days), "days")
