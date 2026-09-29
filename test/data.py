import requests

url = "https://api.dataforseo.com/v3/serp/google/organic/live/advanced"
auth = ("sarabjeet@contenaissance.com", "c077886621151b96")

payload = [{
    "keyword": "content marketing agency",
    "location_code": 2356,
    "language_code": "en",
    "device": "desktop",
    "depth": 10
}]

r = requests.post(url, auth=auth, json=payload).json()

# Top-level check (auth, balance, IP)
print("API status:", r.get("status_code"), "-", r.get("status_message"))

if not r.get("tasks"):
    raise SystemExit("Request rejected - see status above.")

task = r["tasks"][0]
print("Task status:", task.get("status_code"), "-", task.get("status_message"))

if task.get("status_code") != 20000 or not task.get("result"):
    raise SystemExit("Task failed - see status above.")

for item in task["result"][0]["items"]:
    if item["type"] == "organic":
        print(item["rank_absolute"], item["title"], item["url"])