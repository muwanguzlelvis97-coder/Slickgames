import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

// Logs every pick the bot makes and settles it once the match is over.
// Writes data/results.json (used by results.html).

const KEY = process.env.API_FOOTBALL_KEY;
const BASE = 'https://v3.football.api-sports.io';
const MAX_DATES = 5;               // max API requests per run
const SETTLE_AFTER_MIN = 150;      // match is treated as finished 150 min after kick-off
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const load = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch (e) { return d; } };

const results = load('data/results.json', { picks: [] });
const games = load('data/games.json', {});
if (!Array.isArray(results.picks)) results.picks = [];

const tierOf = (s) => (s >= 6 ? 'ULTRA_SAFE' : s === 5 ? 'SAFE' : 'VALUE');
const onTicket = new Set(Object.values(games.tickets || {}).flatMap((t) => (t.games || []).map((g) => g.id)));
const have = new Set(results.picks.map((p) => p.id));

// 1. log new picks
let added = 0;
for (const g of games.passed || []) {
  if (have.has(g.id)) continue;
  results.picks.push({
    id: g.id, kickoff: g.time, league: g.league, league_id: g.league_id, country: g.country, home: g.home, away: g.away,
    pick: g.pick, pick_team: g.pick_team, odd: g.odd, score: g.score,
    tier: tierOf(g.score), on_ticket: onTicket.has(g.id), status: 'pending'
  });
  have.add(g.id);
  added++;
}
// keep on_ticket up to date for picks logged earlier the same day
for (const p of results.picks) if (p.status === 'pending' && onTicket.has(p.id)) p.on_ticket = true;

// 2. settle finished games (one API request per match date)
const now = Date.now();
const due = results.picks.filter((p) => p.status === 'pending' && now > Date.parse(p.kickoff) + SETTLE_AFTER_MIN * 60000);
const dates = [...new Set(due.map((p) => p.kickoff.slice(0, 10)))].sort().slice(0, MAX_DATES);
let used = 0;
for (const d of dates) {
  try {
    if (used > 0) await sleep(6500);
    used++;
    const res = await fetch(`${BASE}/fixtures?date=${d}`, { headers: { 'x-apisports-key': KEY } });
    const data = await res.json();
    if (data.errors && Object.keys(data.errors).length) { console.log('results: API error', JSON.stringify(data.errors)); continue; }
    const byId = new Map((data.response || []).map((f) => [f.fixture.id, f]));
    for (const p of due.filter((x) => x.kickoff.slice(0, 10) === d)) {
      const f = byId.get(p.id);
      if (!f) { if (now > Date.parse(p.kickoff) + 3 * 86400000) p.status = 'unknown'; continue; }
      const st = f.fixture.status.short;
      if (['PST', 'CANC', 'ABD', 'AWD', 'WO', 'SUSP'].includes(st)) { p.status = 'void'; p.final = st; continue; }
      if (!['FT', 'AET', 'PEN'].includes(st)) continue; // not finished yet
      const ft = (f.score && f.score.fulltime && f.score.fulltime.home !== null) ? f.score.fulltime : f.goals;
      if (ft.home === null || ft.away === null) continue;
      const won = p.pick === 'home' ? ft.home > ft.away : ft.away > ft.home;
      p.status = won ? 'won' : 'lost';
      p.final = `${ft.home}-${ft.away}`;
    }
  } catch (e) { console.log('results: error', e.message); }
}

// 3. summary
const settled = results.picks.filter((p) => p.status === 'won' || p.status === 'lost');
const stats = (list) => {
  const w = list.filter((p) => p.status === 'won').length;
  const l = list.filter((p) => p.status === 'lost').length;
  const n = w + l;
  const avgOdd = n ? list.reduce((a, p) => a + p.odd, 0) / n : 0;
  const breakeven = n ? list.reduce((a, p) => a + 1 / p.odd, 0) / n : 0;
  const units = list.reduce((a, p) => a + (p.status === 'won' ? p.odd - 1 : -1), 0);
  return {
    won: w, lost: l, played: n,
    win_rate: n ? Math.round((w / n) * 1000) / 10 : null,
    avg_odd: n ? Math.round(avgOdd * 100) / 100 : null,
    breakeven_rate: n ? Math.round(breakeven * 1000) / 10 : null,
    units: Math.round(units * 100) / 100
  };
};
const band = (o) => (o < 1.2 ? 'under 1.20' : o <= 1.5 ? '1.20 to 1.50' : o <= 2.0 ? '1.51 to 2.00' : 'over 2.00');
const bands = {};
for (const p of settled) (bands[band(p.odd)] = bands[band(p.odd)] || []).push(p);
const byLeague = {};
for (const p of settled) {
  const k = p.league + (p.country ? ' (' + p.country + ')' : '');
  (byLeague[k] = byLeague[k] || []).push(p);
}
const by_league = Object.fromEntries(Object.entries(byLeague).map(([k, v]) => [k, stats(v)]));
const tiers = {};
for (const t of ['ULTRA_SAFE', 'SAFE', 'VALUE']) tiers[t] = stats(settled.filter((p) => p.tier === t));

// ticket results: all games of a ticket tier on one day must win
const tk = {};
for (const p of results.picks.filter((x) => x.on_ticket)) {
  const k = p.kickoff.slice(0, 10) + '|' + p.tier;
  (tk[k] = tk[k] || []).push(p);
}
const ticketStats = { ULTRA_SAFE: { won: 0, lost: 0 }, SAFE: { won: 0, lost: 0 }, VALUE: { won: 0, lost: 0 } };
for (const [k, list] of Object.entries(tk)) {
  const tier = k.split('|')[1];
  if (list.some((p) => p.status === 'lost')) ticketStats[tier].lost++;
  else if (list.every((p) => p.status === 'won' || p.status === 'void') && list.some((p) => p.status === 'won')) ticketStats[tier].won++;
}

results.updated_at = new Date().toISOString();
results.summary = {
  overall: stats(settled),
  pending: results.picks.filter((p) => p.status === 'pending').length,
  tiers,
  tickets: ticketStats,
  by_league,
  odds_bands: Object.fromEntries(['under 1.20', '1.20 to 1.50', '1.51 to 2.00', 'over 2.00'].map((b) => [b, stats(bands[b] || [])]))
};

mkdirSync('data', { recursive: true });
writeFileSync('data/results.json', JSON.stringify(results, null, 2));
console.log(`Results: ${added} new picks logged, ${settled.length} settled, ${results.summary.pending} pending. Requests used: ${used}`);
