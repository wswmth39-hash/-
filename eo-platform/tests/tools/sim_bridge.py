"""TEST-ONLY: posts SIMULATED random-walk ticks to /api/bridge/ingest, exactly like the
bridge userscript would. Never point this at a database you use for real decisions."""
import json, random, sys, time, urllib.request

url, tok, asset, seconds = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
def post(ticks):
    req = urllib.request.Request(url + "/api/bridge/ingest", method="POST",
        data=json.dumps({"client": "sim-test", "assets": [{"asset": asset, "otc": asset.endswith("_OTC"), "ticks": ticks}]}).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + tok})
    return json.loads(urllib.request.urlopen(req).read())
p, now = 1.1, time.time()
hist = []
for i in range(3600, 0, -1):
    p *= 1 + random.gauss(0, 1e-4); hist.append([now - i + 0.3, round(p, 6)])
try:
    print(post(hist), flush=True)
except Exception as e:
    print('history post failed:', e)
end = time.time() + seconds
while time.time() < end:
    p *= 1 + random.gauss(0, 1e-4)
    try:
        r = post([[time.time(), round(p, 6)]])
    except Exception as e:  # server restarting: keep going, like the real bridge
        print("post failed:", e, flush=True)
    time.sleep(0.5)
