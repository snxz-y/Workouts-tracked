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
function buildReviewPrompt(weekLabel, health, activities, nutrition, shifts) {
  const weekStart = weekLabel; // ISO date of Monday

  // Filter data to this week
  const endDate = new Date(weekStart); endDate.setDate(endDate.getDate() + 6);
  const inWeek = d => d >= weekStart && d <= endDate.toISOString().slice(0, 10);

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

WEEK: ${weekStart} to ${endDate.toISOString().slice(0, 10)}

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
        const existing = await ghGet('nutrition.json', token);
        const current = JSON.parse(atob(existing.content));

        // Merge: upsert by date
        const byDate = {};
        current.forEach(e => byDate[e.date] = e);
        const newEntries = Array.isArray(body) ? body : [body];
        newEntries.forEach(e => { if (e.date) byDate[e.date] = { ...byDate[e.date], ...e }; });
        const merged = Object.values(byDate).sort((a, b) => b.date.localeCompare(a.date));

        await ghPut('nutrition.json', JSON.stringify(merged, null, 2), existing.sha, 'Nutrition sync', token);
        return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
      }
    }

    // ── POST /save-review ─────────────────────────────────────────────────
    if (url.pathname === '/save-review' && request.method === 'POST') {
      try {
        const body = await request.json();
        const existing = await ghGet('reviews.json', token);
        const current = JSON.parse(atob(existing.content));
        current.unshift(body);
        await ghPut('reviews.json', JSON.stringify(current, null, 2), existing.sha, 'Save review', token);
        return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, 'Content-Type': 'application/json' } });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
      }
    }

    // ── POST /generate-review ─────────────────────────────────────────────
    if (url.pathname === '/generate-review' && request.method === 'POST') {
      try {
        const reqBody = await request.json();
        const weekLabel = reqBody.week; // e.g. "2026-06-15" (Monday)

        // Fetch all data in parallel
        const [health, activities, nutrition, shifts] = await Promise.all([
          fetchJSON(`${RAW}/health.json`),
          fetchJSON(`${RAW}/activities.json`),
          fetchJSON(`${RAW}/nutrition.json`),
          fetchJSON(`${RAW}/shifts.json`),
        ]);

        const prompt = buildReviewPrompt(
          weekLabel,
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
            max_tokens: 1024,
            messages: [{ role: 'user', content: prompt }]
          })
        });

        const aiData = await aiResp.json();
        const reviewText = aiData.content?.[0]?.text || 'Failed to generate review.';

        return new Response(JSON.stringify({ review: reviewText, week: weekLabel }), {
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

    return new Response('Not found', { status: 404, headers: cors });
  }
};
