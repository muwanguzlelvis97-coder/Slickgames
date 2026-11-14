import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';

// TRIAL VERSION - works on the FREE API-Football plan.
// Uses the /predictions endpoint (recent form, attack, goals, head-to-head) + /odds.
// Rules 1, 2, 4 and 6 are approximations of the full system (free plan has no match-by-match history).

const KEY = process.env.API_FOOTBALL_KEY;
const BASE = 'https://v3.football.api-sports.io';
const MAX_REQUESTS = 30;
const TOTAL_RULES = 6;
const MIN_RULES = 4; // a game must pass at least 4 of the 6 checks (4/6 = Value)
const ALLOW_HOME_PICKS = true;

// Ticket tiers by score: 6/6 Ultra Safe (#1-3), 5/6 Safe (#4-7), 4/6 Value (#8-10)
const TIERS = [
  { key: 'ULTRA_SAFE', score: 6, max: 3 },
  { key: 'SAFE', score: 5, max: 4 },
  { key: 'VALUE', score: 4, max: 3 }
];

const LEAGUES = {
  39: 'England Premier League', 40: 'England Championship', 78: 'Germany Bundesliga',
  88: 'Netherlands Eredivisie', 94: 'Portugal Primeira Liga', 144: 'Belgium Pro League', 253: 'USA MLS'
};
const INTERNATIONAL = {
  1: 'World Cup', 4: 'Euros', 32: 'WC Qualifiers Europe', 34: 'WC Qualifiers South America',
  29: 'WC Qualifiers Africa', 30: 'WC Qualifiers Asia', 31: 'WC Qualifiers CONCACAF',
  33: 'WC Qualifiers Oceania', 37: 'WC Intercontinental Playoffs', 960: 'Euro Qualifiers',
  10: 'International Friendlies'
};
const FRIENDLY_ID = 10;

// Youth (U15-U23) and women's teams are not allowed
const isYouthName = (n) =>
  /\bU-?(15|16|17|18|19|20|21|23)\b/i.test(n) || /\bwomen\b/i.test(n) || /\sW$/.test(n);

let used = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (s) => parseFloat(String(s == null ? '' : s).replace('%', '')) || 0;

async function api(path) {
  if (used >= MAX_REQUESTS) throw new Error('LIMIT');
  if (used > 0) await sleep(6500);
  used++;
  const res = await fetch(BASE + path, { headers: { 'x-apisports-key': KEY } });
  const data = await res.json();
  if (data.errors && Object.keys(data.errors).length) throw new Error(JSON.stringify(data.errors));
  return data.response;
}

// wins for the picked team in the last 3 finished head-to-head games
function h2hWins(list, teamId) {
  const done = (list || [])
    .filter((m) => m.goals && m.goals.home !== null && m.goals.away !== null)
    .sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date))
    .slice(0, 3);
  return done.filter((m) => {
    const home = m.teams.home.id === teamId;
    const gf = home ? m.goals.home : m.goals.away;
    const ga = home ? m.goals.away : m.goals.home;
    return gf > ga;
  }).length;
}

// Kampala date (UTC+3) so the midnight run fetches the new day
const date = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
const out = {
  date, generated_at: new Date().toISOString(), mode: 'TRIAL (free data)',
  games_in_leagues: 0, candidates: 0, requests_used: 0,
  passed: [], tickets: {}, rejected: []
};
const reject = (game, why) => out.rejected.push({ game, why });

// Keep earlier picks from the same day and remember which games were checked
let prev = null;
if (existsSync('data/games.json')) {
  try { prev = JSON.parse(readFileSync('data/games.json', 'utf8')); } catch (e) {}
}
const sameDay = prev && prev.date === date;
const checked = new Set(sameDay ? (prev.checked || []) : []);
let limitHit = false;
if (sameDay) {
  out.passed = prev.passed || [];
  out.rejected = prev.rejected || [];
  out.tickets = prev.tickets || {};
}

try {
  const fixtures = await api(`/fixtures?date=${date}`);
  const isIntl = (f) => INTERNATIONAL[f.league.id] !== undefined;
  let wanted = fixtures.filter((f) =>
    (LEAGUES[f.league.id] || isIntl(f)) && f.fixture.status.short === 'NS' && !checked.has(f.fixture.id) &&
    !isYouthName(f.teams.home.name) && !isYouthName(f.teams.away.name));
  // club leagues first, friendlies last
  wanted.sort((x, y) => (x.league.id === FRIENDLY_ID ? 1 : 0) - (y.league.id === FRIENDLY_ID ? 1 : 0));
  out.games_in_leagues = wanted.length;
  out.candidates = wanted.length;
  console.log('Leagues found today:', [...new Set(wanted.map((f) => `${f.league.id} ${f.league.name} (${f.league.country})`))]);

  for (const f of wanted) {
    const label = `${f.teams.home.name} v ${f.teams.away.name}`;
    if (f.league.id === FRIENDLY_ID && out.passed.some((p) => p.league !== 'Friendlies')) {
      reject(label, 'friendly skipped (league games passed)');
      continue;
    }
    let errored = false;
    try {
      const preds = await api(`/predictions?fixture=${f.fixture.id}`);
      const pr = preds && preds[0];
      if (!pr || !pr.comparison || !pr.teams) { reject(label, 'no prediction data'); continue; }

      // Pick the favourite by the API's overall comparison
      const homeTotal = pct(pr.comparison.total && pr.comparison.total.home);
      const awayTotal = pct(pr.comparison.total && pr.comparison.total.away);
      const pick = homeTotal >= awayTotal ? 'home' : 'away';
      if (pick === 'home' && !ALLOW_HOME_PICKS) { reject(label, 'home pick not allowed'); continue; }
      const me = pick === 'home' ? f.teams.home : f.teams.away;
      const strength = pick === 'home' ? homeTotal : awayTotal;

      const l5 = pr.teams[pick] && pr.teams[pick].last_5;
      if (!l5 || !(l5.played >= 3)) { reject(label, 'not enough recent games'); continue; }
      const form = pct(l5.form);
      const att = pct(l5.att);
      const avgFor = parseFloat(l5.goals && l5.goals.for && l5.goals.for.average) || 0;
      const wins = h2hWins(pr.h2h, me.id);

      // The 6 checks (true = passed). R5 (odds) is added below.
      const r = {
        1: form >= 60,        // R1 form (approx.)
        2: strength >= 60,    // R2 overall strength vs opponent (approx.)
        3: wins >= 2,         // R3 won 2 of last 3 head-to-head
        4: att >= 55,         // R4 attack rating (approx.)
        5: false,             // R5 odds 1.20-1.50
        6: avgFor >= 1.6      // R6 about 8+ goals in last 5 (approx.)
      };
      const others = [1, 2, 3, 4, 6].filter((k) => r[k]).length;
      if (others < MIN_RULES - 1) {
        reject(label, `only ${others} of 5 non-odds checks (failed R${[1, 2, 3, 4, 6].filter((k) => !r[k]).join(', R')})`);
        continue;
      }

      // Odds only for games that can still reach the minimum score
      const odds = await api(`/odds?fixture=${f.fixture.id}&bet=1`);
      const vals = [];
      for (const bm of (odds[0] && odds[0].bookmakers) || []) {
        const bet = bm.bets.find((b) => b.id === 1);
        const v = bet && bet.values.find((x) => x.value === (pick === 'home' ? 'Home' : 'Away'));
        if (v) vals.push(parseFloat(v.odd));
      }
      if (!vals.length) { reject(label, 'no odds'); continue; }
      const odd = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
      r[5] = odd >= 1.2 && odd <= 1.5;

      const failed = Object.keys(r).filter((k) => !r[k]).map(Number);
      const score = TOTAL_RULES - failed.length;
      if (score < MIN_RULES) {
        reject(label, `only ${score}/${TOTAL_RULES} (failed R${failed.join(', R')})`);
        continue;
      }

      out.passed.push({
        id: f.fixture.id, league: f.league.name,
        home: f.teams.home.name, away: f.teams.away.name,
        time: f.fixture.date, pick, pick_team: me.name, odd,
        score, total_rules: TOTAL_RULES, failed_rules: failed,
        form, strength, h2h_wins: wins, attack: att, avg_scored: avgFor
      });
    } catch (e) {
      if (e.message === 'LIMIT') { limitHit = true; reject(label, 'request limit reached'); break; }
      errored = true; // errors are retried on the next run
      reject(label, 'error ' + e.message);
    } finally {
      if (!limitHit && !errored) checked.add(f.fixture.id);
    }
  }
} catch (e) {
  console.log('Stopped early:', e.message);
}

const seen = new Set();
out.rejected = out.rejected.filter((r) => {
  const k = r.game + '|' + r.why;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

// Best score first, then lowest odd
out.passed.sort((a, b) => (b.score || 0) - (a.score || 0) || a.odd - b.odd);

// Build tickets by score tier. Games already on a ticket stay; new games are added until the ticket is full
for (const t of TIERS) {
  const existing = out.tickets[t.key] ? out.tickets[t.key].games : [];
  const have = new Set(existing.map((g) => g.id));
  const room = Math.max(0, t.max - existing.length);
  const add = out.passed.filter((g) => g.score === t.score && !have.has(g.id)).slice(0, room);
  const games = existing.concat(add);
  if (games.length) {
    out.tickets[t.key] = {
      games,
      total_odds: Math.round(games.reduce((a, g) => a * g.odd, 1) * 100) / 100
    };
  }
}
out.checked = [...checked];

out.requests_used = used;
mkdirSync('data', { recursive: true });
writeFileSync('data/games.json', JSON.stringify(out, null, 2));
console.log(`Passed ${MIN_RULES}/${TOTAL_RULES} or more: ${out.passed.length}. Requests used: ${used}`);
