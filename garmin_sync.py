"""
garmin_sync.py - Daily Garmin data sync to GitHub
Runs via GitHub Actions (cloud) OR Windows Task Scheduler (local fallback).

Cloud mode: set env vars GARMIN_OAUTH1_TOKEN, GARMIN_OAUTH1_SECRET, GARMIN_DISPLAY_NAME
Local mode: falls back to reading from ~/.garmin-mcp/ token files as before
"""

import json, base64, os, requests, time, hmac, hashlib, urllib.parse, secrets as _secrets
from datetime import date, datetime, timedelta

# ── CONFIG ────────────────────────────────────────────────────────────────────
GITHUB_TOKEN = os.environ.get("GH_PAT") or os.environ.get("GITHUB_TOKEN", "")
REPO         = "snxz-y/WiggenApp"
TODAY        = date.today().isoformat()
YESTERDAY    = (date.today() - timedelta(days=1)).isoformat()
TOKEN_DIR    = os.path.join(os.environ.get("USERPROFILE", os.path.expanduser("~")), ".garmin-mcp")
BASE         = "https://connectapi.garmin.com"

GH_HEADERS = {
    "Authorization": f"token {GITHUB_TOKEN}",
    "Accept": "application/vnd.github.v3+json",
    "User-Agent": "garmin-sync"
}

def get_oauth2_via_oauth1(oauth1_token, oauth1_secret):
    """Exchange OAuth1 token for a fresh OAuth2 bearer token."""
    cr = requests.get("https://thegarth.s3.amazonaws.com/oauth_consumer.json", timeout=10)
    consumer = cr.json()
    EXCHANGE_URL = "https://connectapi.garmin.com/oauth-service/oauth/exchange/user/2.0"
    ts    = str(int(time.time()))
    nonce = _secrets.token_hex(16)
    oauth_params = {
        "oauth_consumer_key":     consumer["consumer_key"],
        "oauth_nonce":            nonce,
        "oauth_signature_method": "HMAC-SHA1",
        "oauth_timestamp":        ts,
        "oauth_token":            oauth1_token,
        "oauth_version":          "1.0",
    }
    sorted_params = "&".join(
        f"{urllib.parse.quote(k,'')  }={urllib.parse.quote(v,'')}"
        for k, v in sorted(oauth_params.items())
    )
    base_str = f"POST&{urllib.parse.quote(EXCHANGE_URL,'')}&{urllib.parse.quote(sorted_params,'')}"
    signing_key = f"{urllib.parse.quote(consumer['consumer_secret'],'')}&{urllib.parse.quote(oauth1_secret,'')}"
    sig = hmac.new(signing_key.encode(), base_str.encode(), hashlib.sha1).digest()
    import base64 as _b64
    oauth_params["oauth_signature"] = _b64.b64encode(sig).decode()
    auth_header = "OAuth " + ", ".join(
        f'{k}="{urllib.parse.quote(str(v),"")}"' for k, v in oauth_params.items()
    )
    r = requests.post(
        EXCHANGE_URL,
        headers={
            "Authorization": auth_header,
            "User-Agent": "com.garmin.android.apps.connectmobile",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        data="",
        timeout=15,
    )
    r.raise_for_status()
    new_tokens = r.json()
    new_tokens["expires_at"] = int(time.time()) + new_tokens.get("expires_in", 3600)
    print(f"  OAuth2 token obtained. Expires: {datetime.fromtimestamp(new_tokens['expires_at']).strftime('%Y-%m-%d %H:%M')}")
    return new_tokens

def load_tokens():
    """
    Cloud mode: read OAuth1 creds from env vars, exchange for OAuth2.
    Local mode: load from ~/.garmin-mcp files (with refresh-if-expiring logic).
    """
    oauth1_token  = os.environ.get("GARMIN_OAUTH1_TOKEN")
    oauth1_secret = os.environ.get("GARMIN_OAUTH1_SECRET")
    display_name  = os.environ.get("GARMIN_DISPLAY_NAME")

    if oauth1_token and oauth1_secret and display_name:
        # Cloud mode: reuse cached OAuth2 token if still valid
        cache_path = "oauth2_token.json"
        if os.path.exists(cache_path):
            try:
                with open(cache_path) as f:
                    tokens = json.load(f)
                remaining = tokens.get("expires_at", 0) - time.time()
                if remaining > 300:
                    print(f"  Cloud mode: using cached OAuth2 (expires in {int(remaining/60)}m)")
                    return tokens, display_name
                print(f"  Cloud mode: cached token expiring ({int(remaining)}s), refreshing...")
            except Exception as e:
                print(f"  Cloud mode: cache unreadable ({e}), exchanging fresh...")
        else:
            print("  Cloud mode: no cached token, exchanging OAuth1 → OAuth2...")
        tokens = get_oauth2_via_oauth1(oauth1_token, oauth1_secret)
        try:
            with open(cache_path, "w") as f:
                json.dump(tokens, f)
        except Exception as e:
            print(f"  Warning: could not save token cache: {e}")
        return tokens, display_name

    # Local fallback
    print("  Local mode: reading token files...")
    with open(os.path.join(TOKEN_DIR, "oauth2_token.json")) as f:
        tokens = json.load(f)
    with open(os.path.join(TOKEN_DIR, "profile.json")) as f:
        display_name = json.load(f)["displayName"]

    # Refresh if expiring within 2h
    if tokens.get("expires_at", 0) - time.time() < 7200:
        print("  Token expiring soon, refreshing via OAuth1...")
        try:
            with open(os.path.join(TOKEN_DIR, "oauth1_token.json")) as f:
                oauth1 = json.load(f)
            tokens = get_oauth2_via_oauth1(oauth1["oauth_token"], oauth1["oauth_token_secret"])
            with open(os.path.join(TOKEN_DIR, "oauth2_token.json"), "w") as f:
                json.dump(tokens, f, indent=2)
        except Exception as e:
            print(f"  Refresh failed: {e}")

    return tokens, display_name

def garmin_headers(tokens):
    return {
        "Authorization": f"Bearer {tokens['access_token']}",
        "Accept": "application/json",
        "User-Agent": "com.garmin.android.apps.connectmobile",
    }

def gget(url, hdrs, params=None):
    try:
        r = requests.get(url, headers=hdrs, params=params, timeout=15)
        if r.ok: return r.json()
        print(f"  {r.status_code}: {url.split('connectapi.garmin.com')[-1][:60]}")
        return None
    except Exception as e:
        print(f"  Error: {e}")
        return None

def gh_get(filename):
    r = requests.get(f"https://api.github.com/repos/{REPO}/contents/{filename}", headers=GH_HEADERS)
    if r.ok:
        j = r.json()
        return json.loads(base64.b64decode(j["content"].replace("\n",""))), j["sha"]
    return [], None

def gh_put(filename, data, sha, message):
    content = base64.b64encode(json.dumps(data, indent=2).encode()).decode()
    body = {"message": message, "content": content}
    if sha: body["sha"] = sha
    r = requests.put(f"https://api.github.com/repos/{REPO}/contents/{filename}", headers=GH_HEADERS, json=body)
    return r.ok

def sync_health(hdrs, dn, target_date=None):
    TARGET = target_date or YESTERDAY
    print(f"\nFetching health data for {TARGET} (user: {dn[:8]}...)...")

    stats    = gget(f"{BASE}/usersummary-service/usersummary/daily/{dn}?calendarDate={TARGET}", hdrs) or {}
    sleep    = gget(f"{BASE}/wellness-service/wellness/dailySleepData/{dn}?date={TARGET}", hdrs) or {}
    hr       = gget(f"{BASE}/wellness-service/wellness/dailyHeartRate/{dn}?date={TARGET}", hdrs) or {}
    stress   = gget(f"{BASE}/wellness-service/wellness/dailyStress/{TARGET}", hdrs) or {}
    bb       = gget(f"{BASE}/wellness-service/wellness/bodyBattery/reports/daily", hdrs, {"startDate": TARGET, "endDate": TARGET}) or []
    floors   = gget(f"{BASE}/wellness-service/wellness/floorsChartData/daily/{TARGET}", hdrs) or {}
    hrv      = gget(f"{BASE}/hrv-service/hrv/{TARGET}", hdrs) or {}
    weight   = gget(f"{BASE}/weight-service/weight/dateRange", hdrs, {"startDate": TARGET, "endDate": TARGET}) or {}
    readiness= gget(f"{BASE}/metrics-service/metrics/trainingreadiness/{TARGET}", hdrs)
    training = gget(f"{BASE}/metrics-service/metrics/trainingstatus/aggregated/{TARGET}", hdrs) or {}
    endurance= gget(f"{BASE}/metrics-service/metrics/endurancescore", hdrs, {"calendarDate": TARGET}) or {}
    fitness  = gget(f"{BASE}/fitnessage-service/fitnessage/{TARGET}", hdrs) or {}
    im       = gget(f"{BASE}/wellness-service/wellness/daily/im/{TARGET}", hdrs) or {}
    race_raw = gget(f"{BASE}/metrics-service/metrics/racepredictions/latest", hdrs) or {}

    sleep_dto = sleep.get("dailySleepDTO", {}) or {}
    scores = sleep_dto.get("sleepScores", {}) or {}
    sleep_score = None
    if isinstance(scores, dict):
        overall = scores.get("overall", {})
        sleep_score = overall.get("value") if isinstance(overall, dict) else overall

    def ts_to_time(ts):
        if not ts: return None
        try: return datetime.fromtimestamp(ts/1000, tz=__import__("datetime").timezone.utc).strftime("%H:%M")
        except: return None

    hrv_summary = hrv.get("hrvSummary", {}) or {}
    bb_today = next((b for b in (bb if isinstance(bb, list) else [])), {})

    read_val = read_level = read_feedback = None
    if isinstance(readiness, list) and readiness:
        r0 = readiness[0]
        read_val = r0.get("score") or r0.get("trainingReadinessScore")
        read_level = r0.get("level")
        read_feedback = r0.get("feedbackLong") or r0.get("primaryFeedback")
    elif isinstance(readiness, dict):
        read_val = readiness.get("score")
        read_level = readiness.get("level")
        read_feedback = readiness.get("feedbackLong")

    ts_raw = training.get("mostRecentTrainingStatus") or {}
    ts_device_map = ts_raw.get("latestTrainingStatusData", {})
    ts_device = next(iter(ts_device_map.values()), {}) if ts_device_map else {}
    ts_num = ts_device.get("trainingStatus")
    ts_map = {1:"OVERREACHING",2:"MAINTAINING",3:"PRODUCTIVE",4:"RECOVERY",5:"UNPRODUCTIVE",6:"STRAINED",7:"PRODUCTIVE",8:"PEAKING"}
    ts_status = ts_map.get(ts_num, ts_raw.get("trainingStatusKey")) if ts_num else ts_raw.get("trainingStatusKey")
    acute_dto = ts_device.get("acuteTrainingLoadDTO") or {}
    acwr_val = acute_dto.get("dailyAcuteChronicWorkloadRatio")
    acute_val = acute_dto.get("dailyTrainingLoadAcute")
    chronic_val = acute_dto.get("dailyTrainingLoadChronic")
    lb_raw = training.get("mostRecentTrainingLoadBalance") or {}
    device_map = lb_raw.get("metricsTrainingLoadBalanceDTOMap", {})
    lb = next(iter(device_map.values()), {}) if device_map else lb_raw
    _ft_map = {1:"AEROBIC LOW FOCUS", 2:"AEROBIC HIGH FOCUS", 3:"ANAEROBIC FOCUS", 4:"AEROBIC LOW FOCUS"}
    load_focus = (
        str(lb.get("loadFocusLabel") or lb.get("trainingBalanceFeedbackPhrase") or lb.get("label") or lb.get("trainingLoadBalanceLabel") or "").replace("_"," ") or
        _ft_map.get(ts_device.get("fitnessTrend")) or
        None
    )
    acute_load   = acute_val or lb.get("acuteLoad") or lb.get("acute7DayLoad")
    chronic_load = chronic_val or lb.get("chronicLoad") or lb.get("chronic28DayLoad")
    aerobic_low  = lb.get("aerobicLowLoad") or lb.get("lowAerobicLoad") or lb.get("monthlyLoadAerobicLow")
    aerobic_high = lb.get("aerobicHighLoad") or lb.get("highAerobicLoad") or lb.get("monthlyLoadAerobicHigh")
    anaerobic    = lb.get("anaerobicLoad") or lb.get("monthlyLoadAnaerobic")

    end_score = endurance.get("overallScore")
    cls_map = {1:"Beginner",2:"Intermediate",3:"Trained",4:"Well-trained",5:"Expert",6:"Superior",7:"Elite"}
    end_class = cls_map.get(endurance.get("classification"), "Intermediate")

    fa_val = fitness.get("fitnessAge") or fitness.get("vo2MaxPreciseValue")

    wt_list = weight.get("dateWeightList", [])
    body_today = next((b for b in wt_list if b.get("calendarDate") == TARGET), {})
    wt_val = body_today.get("weight")
    if wt_val: wt_val = round(wt_val / 1000, 2)

    _rt_candidates = []
    if isinstance(readiness, list):
        for r in readiness:
            v = r.get("recoveryTime")
            if v is not None: _rt_candidates.append(v)
    elif isinstance(readiness, dict):
        v = readiness.get("recoveryTime")
        if v is not None: _rt_candidates.append(v)
    v = ts_device.get("recoveryTime")
    if v is not None: _rt_candidates.append(v)
    _rt_raw = max(_rt_candidates) if _rt_candidates else None
    _recovery_hrs = round(_rt_raw / 60, 1) if _rt_raw and _rt_raw > 24 else _rt_raw

    entry = {
        "date": TARGET,
        "rhr": stats.get("restingHeartRate") or stats.get("minHeartRate") or hr.get("restingHeartRate"),
        "minHR": stats.get("minHeartRate") or hr.get("minHeartRate"),
        "maxHR": stats.get("maxHeartRate") or hr.get("maxHeartRate"),
        "avgStress": stress.get("avgStressLevel") or stats.get("averageStressLevel"),
        "maxStress": stress.get("maxStressLevel") or stats.get("maxStressLevel"),
        "steps": stats.get("totalSteps"),
        "stepsGoal": stats.get("dailyStepGoal", 9590),
        "floors": stats.get("floorsAscendedInMeters") or stats.get("floorsAscended") or floors.get("floorsAscended"),
        "floorsGoal": 10,
        "activeKcal": stats.get("activeKilocalories"),
        "totalKcal": stats.get("totalKilocalories"),
        "bmrKcal": stats.get("bmrKilocalories"),
        "modIntensityMin": stats.get("moderateIntensityMinutes"),
        "vigIntensityMin": stats.get("vigorousIntensityMinutes"),
        "weeklyIntensityTotal": im.get("weeklyTotal"),
        "weeklyIntensityGoal": im.get("weekGoal", 150),
        "bbHigh": stats.get("bodyBatteryHighestValue") or bb_today.get("highValue"),
        "bbLow": stats.get("bodyBatteryLowestValue") or bb_today.get("lowValue"),
        "bbWake": stats.get("bodyBatteryAtWakeTime"),
        "bbEnd": stats.get("bodyBatteryMostRecentValue"),
        "bbCharged": stats.get("bodyBatteryChargedValue"),
        "bbDrained": stats.get("bodyBatteryDrainedValue"),
        "sleepScore": sleep_score,
        "sleepSec": sleep_dto.get("sleepTimeSeconds"),
        "deepSec": sleep_dto.get("deepSleepSeconds"),
        "remSec": sleep_dto.get("remSleepSeconds"),
        "lightSec": sleep_dto.get("lightSleepSeconds"),
        "awakeSec": sleep_dto.get("awakeSleepSeconds"),
        "bedTime": ts_to_time(sleep_dto.get("sleepStartTimestampLocal")),
        "wakeTime": ts_to_time(sleep_dto.get("sleepEndTimestampLocal")),
        "avgResp": sleep_dto.get("averageRespirationValue"),
        "hrvAvg": hrv_summary.get("lastNightAvg") or hrv_summary.get("lastNight5MinHigh"),
        "hrvWeeklyAvg": hrv_summary.get("weeklyAvg") or hrv_summary.get("weekly5MinHigh"),
        "hrvStatus": hrv_summary.get("status"),
        "trainingReadiness": read_val,
        "trainingReadinessLevel": str(read_level).upper().replace("_"," ") if read_level else None,
        "trainingReadinessFeedback": str(read_feedback).replace("_"," ") if read_feedback else None,
        "trainingStatus": ts_status.get("trainingStatusKey") if isinstance(ts_status, dict) else ts_status,
        "acuteLoad": acute_load,
        "chronicLoad": chronic_load,
        "acwr": round(acwr_val, 2) if acwr_val else (round(acute_load/chronic_load, 2) if acute_load and chronic_load else None),
        "loadFocus": load_focus,
        "aerobicLowLoad": aerobic_low,
        "aerobicHighLoad": aerobic_high,
        "anaerobicLoad": anaerobic,
        "aerobicLowMin": 130, "aerobicLowMax": 342,
        "aerobicHighMin": 256, "aerobicHighMax": 467,
        "anaerobicMin": 0, "anaerobicMax": 211,
        "vo2max": (training.get("mostRecentVO2Max") or {}).get("generic", {}).get("vo2MaxValue") or stats.get("vo2Max"),
        "enduranceScore": end_score,
        "enduranceClass": end_class,
        "fitnessAge": round(fa_val, 1) if fa_val else None,
        "recoveryTimeHrs": _recovery_hrs,
        "lactateHR": 184,
        "weight": wt_val,
        "bmi": body_today.get("bmi"),
        "bodyFat": body_today.get("bodyFat") or body_today.get("bodyFatPercentage"),
        "muscleMass": round(body_today["muscleMass"]/1000, 2) if body_today.get("muscleMass") and body_today["muscleMass"] > 500 else body_today.get("muscleMass"),
        "boneMass": round(body_today["boneMass"]/1000, 2) if body_today.get("boneMass") and body_today["boneMass"] > 100 else body_today.get("boneMass"),
        "bodyWater": body_today.get("bodyWater"),
        "race5kSec": race_raw.get("time5K"),
        "race10kSec": race_raw.get("time10K"),
        "raceHalfSec": race_raw.get("timeHalfMarathon"),
        "raceMarathonSec": race_raw.get("timeMarathon"),
    }

    print(f"  Steps:{entry.get('steps')} RHR:{entry.get('rhr')} BB:{entry.get('bbWake')} Sleep:{entry.get('sleepSec')}s")

    existing, sha = gh_get("health.json")
    filtered = [e for e in existing if e.get("date") != TARGET]
    new_data = sorted([entry] + filtered, key=lambda x: x["date"], reverse=True)
    ok = gh_put("health.json", new_data, sha, f"Health sync {TARGET}")
    print(f"  health.json: {'OK' if ok else 'FAILED'}")


LABEL_MAP = {
    'IMPACTING_TEMPO': 'Tempo',
    'IMPACTING_BASE': 'Aerobic base',
    'IMPACTING_THRESHOLD': 'Lactate threshold',
    'IMPACTING_VO2MAX': 'VO2 Max',
    'IMPACTING_ANAEROBIC': 'Anaerobic',
    'IMPACTING_SPRINT': 'Sprint',
    'MAINTAINING_TEMPO': 'Maintaining Tempo',
    'MAINTAINING_BASE': 'Maintaining base',
    'MAINTAINING_THRESHOLD': 'Maintaining threshold',
    'NO_IMPACT': 'Recovery',
    'RECOVERY': 'Recovery',
}
def _translate_label(msg):
    if not msg:
        return None
    import re as _re
    key = _re.sub(r'_\d+$', '', msg.upper()).replace('HIGHLY_IMPACTING_', 'IMPACTING_').replace('HIGHLY_MAINTAINING_', 'MAINTAINING_')
    return LABEL_MAP.get(key, msg.replace('_', ' ').title())

def sync_activities(hdrs):
    print(f"\nFetching activities ({YESTERDAY} to {TODAY})...")

    acts = gget(f"{BASE}/activitylist-service/activities/search/activities", hdrs, {
        "startDate": YESTERDAY, "endDate": TODAY, "limit": 20
    }) or []

    if not acts:
        print("  No new activities.")
        return

    existing, sha = gh_get("activities.json")
    existing_by_id = {a.get("activityId"): a for a in existing}
    changed = 0

    for act in acts:
        aid = act.get("activityId")

        zones = [0,0,0,0,0]
        try:
            zd = gget(f"{BASE}/activity-service/activity/{aid}/hrTimeInZones", hdrs) or []
            for z in (zd if isinstance(zd, list) else []):
                idx = z.get("zoneNumber", 1) - 1
                if 0 <= idx < 5:
                    zones[idx] = z.get("secsInZone", 0)
        except: pass

        splits = []
        try:
            sp = gget(f"{BASE}/activity-service/activity/{aid}/splits", hdrs) or {}
            raw_splits = sp.get("lapDTOs") or sp.get("splits") or (sp if isinstance(sp, list) else [])
            for lap in raw_splits:
                splits.append({
                    "lap": lap.get("lapIndex") or lap.get("messageIndex"),
                    "distanceM": lap.get("distance"),
                    "durationSec": lap.get("duration"),
                    "avgHR": lap.get("averageHR"),
                    "maxHR": lap.get("maxHR"),
                    "avgPace": lap.get("averageSpeed"),
                    "elevGain": lap.get("elevationGain"),
                    "calories": lap.get("calories"),
                })
        except: pass

        t = act.get("activityType", {}).get("typeKey", "")
        atype = "running" if "running" in t else "cycling" if ("cycling" in t or "biking" in t) else "walking" if "walking" in t else t

        entry = {
            "activityId": aid,
            "date": (act.get("startTimeLocal") or TODAY)[:10],
            "startTime": act.get("startTimeLocal") or TODAY,
            "type": atype,
            "name": act.get("activityName", "Activity"),
            "distanceM": act.get("distance"),
            "durationSec": act.get("duration"),
            "elevGain": act.get("elevationGain"),
            "elevLoss": act.get("elevationLoss"),
            "avgHR": act.get("averageHR"),
            "maxHR": act.get("maxHR"),
            "calories": act.get("calories"),
            "load": act.get("activityTrainingLoad"),
            "vo2max": act.get("vO2MaxValue"),
            "bodyBatDrain": abs(act.get("differenceBodyBattery") or 0) or None,
            "cadence": act.get("averageRunningCadenceInStepsPerMinute") or act.get("averageBikingCadenceInRevPerMinute"),
            "maxCadence": act.get("maxRunningCadenceInStepsPerMinute") or act.get("maxBikingCadenceInRevPerMinute"),
            "strideLen": act.get("avgStrideLength"),
            "gct": act.get("avgGroundContactTime"),
            "vo": act.get("avgVerticalOscillation"),
            "vertRatio": act.get("avgVerticalRatio"),
            "avgPower": act.get("avgPower"),
            "maxPower": act.get("maxPower"),
            "normPower": act.get("normPower"),
            "avgResp": act.get("avgRespirationRate"),
            "minResp": act.get("minRespirationRate"),
            "maxResp": act.get("maxRespirationRate"),
            "fastest1k": act.get("fastestSplit_1000"),
            "fastest1609": act.get("fastestSplit_1609"),
            "fastest5k": act.get("fastestSplit_5000"),
            "fastest10k": act.get("fastestSplit_10000"),
            "maxSpeed": act.get("maxSpeed"),
            "steps": act.get("steps"),
            "z1": zones[0], "z2": zones[1], "z3": zones[2], "z4": zones[3], "z5": zones[4],
            "label": _translate_label(act.get("aerobicTrainingEffectMessage")),
            "splits": splits,
        }
        # Upsert: insert new activities, repair partial/foreign-schema entries,
        # and refresh recent ones so metrics Garmin computes a few minutes after
        # the activity (power, running dynamics, HR zones, VO2max, training load)
        # are filled in on a later run instead of being frozen as nulls.
        prior = existing_by_id.get(aid)
        if prior is None:
            existing.append(entry)
            existing_by_id[aid] = entry
            changed += 1
            print(f"  Added: {entry['name']} ({entry['date']}, {entry['type']})")
        elif "distanceM" not in prior:
            # Entry was written with a different/partial schema (e.g. hand-added
            # via Garmin MCP). Replace it with the canonical full entry.
            prior.clear()
            prior.update(entry)
            changed += 1
            print(f"  Repaired: {entry['name']} ({entry['date']}, {entry['type']})")
        else:
            updated = False
            for k, v in entry.items():
                # Only overwrite with real values; never clobber good data with a null.
                if v is not None and v != [] and prior.get(k) != v:
                    prior[k] = v
                    updated = True
            if updated:
                changed += 1
                print(f"  Updated: {entry['name']} ({entry['date']}, {entry['type']})")

    if changed > 0:
        new_data = sorted(existing, key=lambda x: x.get("startTime") or x.get("date",""), reverse=True)
        ok = gh_put("activities.json", new_data, sha, f"Activity sync {TODAY} ({changed} changed)")
        print(f"  activities.json: {'OK' if ok else 'FAILED'} ({changed} changed)")
    else:
        print("  No activity changes.")

if __name__ == "__main__":
    print(f"=== Garmin Sync {TODAY} ===")
    try:
        tokens, display_name = load_tokens()
        hdrs = garmin_headers(tokens)
        print(f"  Expires: {datetime.fromtimestamp(tokens['expires_at']).strftime('%Y-%m-%d %H:%M')}")
        sync_health(hdrs, display_name)        # yesterday (finalized)
        sync_health(hdrs, display_name, TODAY)  # today (live)
        sync_activities(hdrs)
        print(f"\nDone. Synced health for {YESTERDAY}+{TODAY}, activities for {YESTERDAY}-{TODAY}.")
    except Exception as e:
        print(f"\nFailed: {e}")
        import traceback, sys
        traceback.print_exc()
        # Exit non-zero so a failed run shows red in GitHub Actions instead of
        # silently passing (e.g. a Garmin 429 on the OAuth token exchange).
        sys.exit(1)
