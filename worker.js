// Cloudflare Worker — WiggenApp backend
// Handles: / (nutrition), /save-review, /generate-review
// Deploy at: https://nutrition-reciever.margidowiggen.workers.dev

const REPO = 'snxz-y/WiggenApp';
const GH = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com/snxz-y/WiggenApp/main';

async function ghGet(path, token) {
  const r = await fetch(`${GH}/repos/${REPO}/contents/${path}`, {
    headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'wt' }
  });
  return r.json();
}

// Decode a base64 blob as UTF-8 (plain atob() is Latin-1 and mangles non-ASCII
// like →, é, etc. — which both breaks matching and re-garbles titles on save).
function b64utf8(b64) {
  const bin = atob((b64 || '').replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
  return new TextDecoder('utf-8').decode(bytes);
}

async function ghPut(path, content, sha, msg, token) {
  const r = await fetch(`${GH}/repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json', 'User-Agent': 'wt' },
    body: JSON.stringify({ message: msg, content: btoa(unescape(encodeURIComponent(content))), sha })
  });
  return r.json();
}

async function fetchJSON(url) {
  const r = await fetch(url + '?nc=' + Date.now());
  if (!r.ok) return null;
  return r.json();
}

// ── Classify shift type ────────────────────────────────────────────────────
function classifyShift(shift) {
  if (!shift) return 'off';
  return shift.shiftType || 'off';
}

// ── Build a shift-aware weekly review prompt ───────────────────────────────
function buildReviewPrompt(weekStart, weekEnd, health, activities, nutrition, shifts) {
  // weekStart / weekEnd are ISO dates (YYYY-MM-DD). Fall back to a 7-day window.
  let endStr = weekEnd;
  if (!endStr) { const e = new Date(weekStart); e.setDate(e.getDate() + 6); endStr = e.toISOString().slice(0, 10); }

  // Filter data to this period
  const inWeek = d => d >= weekStart && d <= endStr;

  const weekHealth = health.filter(h => inWeek(h.date)).sort((a, b) => a.date.localeCompare(b.date));
  const weekActs = activities.filter(a => inWeek(a.date));
  const weekNutr = nutrition.filter(n => inWeek(n.date));
  const weekShifts = shifts.filter(s => inWeek(s.date));

  const avg = (arr, key) => {
    const v = arr.filter(x => x[key] != null).map(x => x[key]);
    return v.length ? (v.reduce((s, x) => s + x, 0) / v.length).toFixed(1) : 'N/A';
  };

  const runs = weekActs.filter(a => a.type === 'running');
  const totalKm = runs.reduce((s, r) => s + (r.distanceM || 0) / 1000, 0).toFixed(1);
  const intervalRuns = runs.filter(r => /interval|tempo|fartlek/i.test(r.name || ''));

  // Shift summary
  const dayShifts = weekShifts.filter(s => s.shiftType === 'day');
  const eveShifts = weekShifts.filter(s => s.shiftType === 'evening');
  const offDays = weekShifts.filter(s => s.shiftType === 'off');
  const shiftSummary = `Day shifts: ${dayShifts.length} (${dayShifts.map(s => s.date.slice(5)).join(', ') || 'none'})
Evening shifts: ${eveShifts.length} (${eveShifts.map(s => s.date.slice(5)).join(', ') || 'none'})
Days off: ${offDays.length}`;

  // Per-day shift+health table
  const dayRows = weekHealth.map(h => {
    const shift = weekShifts.find(s => s.date === h.date);
    const act = weekActs.filter(a => a.date === h.date);
    const nutr = weekNutr.find(n => n.date === h.date);
    return `${h.date} | ${shift ? `${shift.shiftType} (${shift.start || 'off'})` : 'no shift data'} | sleep ${h.sleepScore ?? '?'} (${h.sleepSec ? Math.round(h.sleepSec / 3600 * 10) / 10 : '?'}h) | HRV ${h.hrvAvg ?? '?'} | RHR ${h.rhr ?? '?'} | steps ${h.steps ?? '?'} | BB ${h.bbHigh ?? '?'} | ${act.length ? act.map(a => `${a.type}${a.distanceM ? ' ' + (a.distanceM / 1000).toFixed(1) + 'km' : ''}`).join(', ') : 'rest'} | ${nutr ? `${nutr.calories ?? '?'} kcal, ${nutr.protein ?? '?'}g P` : 'no nutrition'}`;
  }).join('\n');

  const lastWeight = [...health].filter(h => h.weight).sort((a, b) => b.date.localeCompare(a.date))[0];

  return `You are a data-driven health and performance coach analyzing a week of data for Jørgen (28, shift nurse in Trondheim, Norway, 171cm, ~${lastWeight?.weight ?? 76}kg, goal 65kg, quit Zyn June 5 2026, dairy allergy, Garmin Epix Pro Gen 2).

WEEK: ${weekStart} to ${endStr}

== WORK SCHEDULE ==
${shiftSummary}

== DAILY LOG (date | shift | sleep | HRV | RHR | steps | body battery | activity | nutrition) ==
${dayRows || 'No data available'}

== WEEKLY AVERAGES ==
Sleep score: ${avg(weekHealth, 'sleepScore')} | HRV: ${avg(weekHealth, 'hrvAvg')} | RHR: ${avg(weekHealth, 'rhr')} bpm
Steps/day: ${avg(weekHealth, 'steps')} | Body battery peak: ${avg(weekHealth, 'bbHigh')} | Avg stress: ${avg(weekHealth, 'avgStress')}
Calories/day: ${avg(weekNutr, 'calories')} kcal | Protein/day: ${avg(weekNutr, 'protein')}g

== TRAINING ==
Total runs: ${runs.length} | Total km: ${totalKm} km
Interval sessions: ${intervalRuns.length} (${intervalRuns.map(r => r.name || 'interval').join(', ') || 'none'})
Other activities: ${weekActs.filter(a => a.type !== 'running').map(a => a.type).join(', ') || 'none'}

== BODY COMP ==
Weight: ${lastWeight?.weight ?? 'N/A'} kg | Body fat: ${lastWeight?.bodyFat ?? 'N/A'}%

Write a weekly review (300-400 words) covering:
1. **Shift Impact** — How did the shift pattern this week affect sleep, recovery (HRV, RHR), energy (body battery), and eating? Note any day-shift vs evening-shift differences. Flag if evening shifts pushed bedtime later and hurt sleep.
2. **Training** — Quality and volume relative to recovery. Were workouts timed well around shifts? Any signs of overtraining or under-recovery?
3. **Nutrition** — Calorie and protein intake relative to targets (1600 kcal goal, 150g protein). How did work schedule affect eating habits?
4. **Recovery** — Overall readiness trend. HRV, sleep score, body battery. Anything to watch?
5. **Key Takeaway** — One concrete thing to do differently next week based on the shift schedule.

Be specific, use the numbers, and be honest. Tone: like a smart coach who knows the data cold.`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const token = env.GITHUB_TOKEN;
    const anthropicKey = env.ANTHROPIC_KEY;

    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    // ── POST / — save nutrition ────────────────────────────────────────────
    if (url.pathname === '/' && request.method === 'POST') {
      try {
        const body = await request.json();

        // Parse Health Auto Export format: { data: { metrics: [...] } }
        // Each metric has name + data array of { date: "2026-06-15 12:00:00 +0200", qty: N }
        let newEntries;
        if (body?.data?.metrics) {
          const nameMap = {
            'dietary_energy': 'calories',
            'protein': 'protein',
            'carbohydrates': 'carbs',
            'total_fat': 'fat',
            'dietary_sugar': 'sugar',
            'fiber': 'fiber',
            'saturated_fat': 'saturatedFat',
            'water': 'water',
          };
          const dayMap = {};
          for (const metric of body.data.metrics) {
            const field = nameMap[metric.name];
            if (!field) continue;
            // dietary_energy from Apple Health is in kJ — convert to kcal
            const isEnergy = metric.name === 'dietary_energy';
            for (const point of (metric.data || [])) {
              const date = point.date?.slice(0, 10);
              if (!date) continue;
              if (!dayMap[date]) dayMap[date] = { date };
              const qty = isEnergy ? (point.qty || 0) / 4.184 : (point.qty || 0);
              dayMap[date][field] = (dayMap[date][field] || 0) + qty;
            }
          }
          newEntries = Object.values(dayMap).map(entry => {
            const out = { date: entry.date };
            for (const [k, v] of Object.entries(entry)) {
              if (k !== 'date') out[k] = Math.round(v * 10) / 10;
            }
            return out;
          });
        } else {
          // Legacy format: array or single object with date field
          newEntries = Array.isArray(body) ? body : [body];
        }

        const existing = await ghGet('nutrition.json', token);
        const current = JSON.parse(atob(existing.content));
        const byDate = {};
        current.forEach(e => byDate[e.date] = e);
        newEntries.forEach(e => { if (e.date) byDate[e.date] = { ...byDate[e.date], ...e }; });
        const merged = Object.values(byDate).sort((a, b) => b.date.localeCompare(a.date));

        const putResult = await ghPut('nutrition.json', JSON.stringify(merged, null, 2), existing.sha, 'Nutrition sync', token);
        if (putResult.content || putResult.commit) {
          return new Response(JSON.stringify({ ok: true, dates: newEntries.map(e => e.date) }), { headers: { ...cors, 'Content-Type': 'application/json' } });
        } else {
          return new Response(JSON.stringify({ error: 'GitHub write failed', detail: putResult.message || JSON.stringify(putResult) }), { status: 500, headers: cors });
        }
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
      }
    }

    // ── POST /save-review ─────────────────────────────────────────────────
    if (url.pathname === '/save-review' && request.method === 'POST') {
      try {
        const body = await request.json();
        const existing = await ghGet('reviews.json', token);
        const current = JSON.parse(b64utf8(existing.content));
        current.unshift(body);
        await ghPut('reviews.json', JSON.stringify(current, null, 2), existing.sha, 'Save review', token);
        return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
      }
    }

    // ── POST /delete-review ───────────────────────────────────────────────
    if (url.pathname === '/delete-review' && request.method === 'POST') {
      try {
        const { date, period, content } = await request.json();
        const existing = await ghGet('reviews.json', token);
        const current = JSON.parse(b64utf8(existing.content));
        // Remove only the first entry that matches exactly (handles duplicates).
        const idx = current.findIndex(r => r.date === date && r.period === period && r.content === content);
        if (idx === -1) {
          return new Response(JSON.stringify({ ok: false, error: 'Review not found' }), { status: 404, headers: { ...cors, 'Content-Type': 'application/json' } });
        }
        current.splice(idx, 1);
        await ghPut('reviews.json', JSON.stringify(current, null, 2), existing.sha, 'Delete review', token);
        return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
      }
    }

    // ── POST /generate-review ─────────────────────────────────────────────
    if (url.pathname === '/generate-review' && request.method === 'POST') {
      try {
        const reqBody = await request.json();
        const start = reqBody.start || reqBody.week; // ISO start date
        const end = reqBody.end;                     // ISO end date (optional)
        if (!start) {
          return new Response(JSON.stringify({ error: 'Missing start date' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
        }

        // Fetch all data in parallel
        const [health, activities, nutrition, shifts] = await Promise.all([
          fetchJSON(`${RAW}/health.json`),
          fetchJSON(`${RAW}/activities.json`),
          fetchJSON(`${RAW}/nutrition.json`),
          fetchJSON(`${RAW}/shifts.json`),
        ]);

        const prompt = buildReviewPrompt(
          start,
          end,
          health || [],
          activities || [],
          nutrition || [],
          shifts || []
        );

        const aiResp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': anthropicKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 3000,
            messages: [{ role: 'user', content: prompt }]
          })
        });

        const aiData = await aiResp.json();
        const reviewText = aiData.content?.[0]?.text || 'Failed to generate review.';

        return new Response(JSON.stringify({ review: reviewText, week: start }), {
          headers: { ...cors, 'Content-Type': 'application/json' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
      }
    }

    // ── POST /sync-garmin — trigger GitHub Actions workflow ───────────────────
    if (url.pathname === '/sync-garmin' && request.method === 'POST') {
      try {
        const r = await fetch(`${GH}/repos/${REPO}/actions/workflows/garmin-sync.yml/dispatches`, {
          method: 'POST',
          headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
            'User-Agent': 'wt'
          },
          body: JSON.stringify({ ref: 'main' })
        });
        if (r.status === 204) {
          return new Response(JSON.stringify({ ok: true, message: 'Sync triggered — data updates in ~60s' }), {
            headers: { ...cors, 'Content-Type': 'application/json' }
          });
        }
        const err = await r.text();
        return new Response(JSON.stringify({ error: err }), { status: r.status, headers: cors });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
      }
    }

    // ── POST /debug — echo back the raw request body ─────────────────────
    if (url.pathname === '/debug' && request.method === 'POST') {
      const raw = await request.text();
      return new Response(JSON.stringify({ received: raw }), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    return new Response('Not found', { status: 404, headers: cors });
  }
};
