"""Download the dashboard's 311 data as GeoJSON for QGIS.

Run from the repo root:  python scripts/fetch_311_geojson.py
Writes data/raw/:
  311_june2026.geojson      June 1-30, 2026 (storm month, deduplicated)
  311_last90d.geojson       last 90 days (deduplicated)
  community_areas.geojson   77 community areas (igwz-8jzy)
Same filter as the web app: 4 storm categories, duplicate = false.
"""
import json, os, time, urllib.parse, urllib.request
from datetime import datetime, timedelta

API = "https://data.cityofchicago.org/resource/v6vf-nfxy.json"
TYPES = ["Tree Emergency", "Tree Debris Clean-Up Request", "Water in Basement Complaint", "Water On Street Complaint"]
KEY = {"Tree Emergency": "tree_emergency", "Tree Debris Clean-Up Request": "tree_debris",
       "Water in Basement Complaint": "water_basement", "Water On Street Complaint": "water_street"}
OUT = os.path.join("data", "raw")


def get(url, tries=5):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "chicago-311-dashboard"}), timeout=180) as r:
                return r.read()
        except Exception as e:  # the portal returns 5xx under load
            print("  retry", i + 1, e)
            time.sleep(3 * 2 ** i)
    raise RuntimeError("311 API failed: " + url[:120])


def fetch(since, until):
    where = "sr_type in(%s) AND duplicate=false AND created_date>='%s' AND created_date<'%s'" % (
        ",".join("'%s'" % t for t in TYPES), since, until)
    rows, off = [], 0
    while True:
        q = urllib.parse.urlencode({"$select": "sr_number,sr_type,status,created_date,closed_date,latitude,longitude,community_area,ward,street_address",
                                    "$where": where, "$order": "created_date", "$limit": 50000, "$offset": off})
        page = json.loads(get(API + "?" + q))
        rows += page
        if len(page) < 50000:
            return rows
        off += 50000


def write(rows, name):
    feats = [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [float(r["longitude"]), float(r["latitude"])]},
              "properties": {"sr_number": r["sr_number"], "category": KEY[r["sr_type"]], "sr_type": r["sr_type"],
                             "group": "tree" if r["sr_type"].startswith("Tree") else "water",
                             "status": r.get("status"), "created": r["created_date"], "closed": r.get("closed_date"),
                             "ca_num": int(r["community_area"]) if r.get("community_area") else None,
                             "ward": int(r["ward"]) if r.get("ward") else None, "address": r.get("street_address")}}
             for r in rows if r.get("latitude") and r.get("longitude")]
    path = os.path.join(OUT, name)
    json.dump({"type": "FeatureCollection", "features": feats}, open(path, "w", encoding="utf-8"))
    print(name, len(feats), "points")


os.makedirs(OUT, exist_ok=True)
import sys
if "--baseline" in sys.argv:   # same month, three prior years: the "normal June" baseline
    for y in (2023, 2024, 2025):
        write(fetch(f"{y}-06-01T00:00:00", f"{y}-07-01T00:00:00"), f"311_june{y}.geojson")
    sys.exit()
write(fetch("2026-06-01T00:00:00", "2026-07-01T00:00:00"), "311_june2026.geojson")
now = datetime.now()
write(fetch((now - timedelta(days=90)).strftime("%Y-%m-%dT%H:%M:%S"), (now + timedelta(days=1)).strftime("%Y-%m-%dT00:00:00")), "311_last90d.geojson")
open(os.path.join(OUT, "community_areas.geojson"), "wb").write(get("https://data.cityofchicago.org/resource/igwz-8jzy.geojson"))
print("community_areas.geojson saved")
