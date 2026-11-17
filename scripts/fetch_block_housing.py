"""2020 Census block housing units (HU100) and population (POP100) as points, from TIGERweb (no API key).

Run from the repo root:  python scripts/fetch_block_housing.py
Writes data/raw/blocks2020_chicago.geojson: one point per block at its internal point, inside Chicago's bounding box.
HU100 is housing units (occupied + vacant), not households.
"""
import json, os, time, urllib.parse, urllib.request

URL = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer/12/query"
BBOX = "-87.95,41.64,-87.52,42.03"


def get(params, tries=5):
    for i in range(tries):
        try:
            req = urllib.request.Request(URL + "?" + urllib.parse.urlencode(params), headers={"User-Agent": "chicago-311-dashboard"})
            with urllib.request.urlopen(req, timeout=180) as r:
                return json.loads(r.read())
        except Exception as e:
            print("  retry", i + 1, e); time.sleep(3 * 2 ** i)
    raise RuntimeError("TIGERweb failed")


feats, off = [], 0
while True:
    d = get({"where": "STATE='17' AND COUNTY='031'", "geometry": BBOX, "geometryType": "esriGeometryEnvelope", "inSR": 4326,
             "spatialRel": "esriSpatialRelIntersects", "outFields": "GEOID,HU100,POP100,INTPTLAT,INTPTLON",
             "returnGeometry": "false", "resultOffset": off, "resultRecordCount": 5000, "orderByFields": "OBJECTID", "f": "json"})
    rows = d.get("features", [])
    for r in rows:
        a = r["attributes"]
        feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [float(a["INTPTLON"]), float(a["INTPTLAT"])]},
                      "properties": {"geoid": a["GEOID"], "hu2020": a["HU100"], "pop2020": a["POP100"]}})
    print("blocks", len(feats))
    if len(rows) < 5000 and not d.get("exceededTransferLimit"):
        break
    off += len(rows)
os.makedirs(os.path.join("data", "raw"), exist_ok=True)
json.dump({"type": "FeatureCollection", "features": feats}, open(os.path.join("data", "raw", "blocks2020_chicago.geojson"), "w"))
print("total housing units", sum(f["properties"]["hu2020"] or 0 for f in feats))
