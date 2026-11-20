import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';

// TRIAL VERSION - works on the FREE API-Football plan.
// Uses the /predictions endpoint (recent form, attack, goals, head-to-head) + /odds.
// Rules 1, 2, 4 and 6 are approximations of the full system (free plan has no match-by-match history).

const KEY = process.env.API_FOOTBALL_KEY;
const BASE = 'https://v3.football.api-sports.io';
const MAX_REQUESTS = 80;
const TOTAL_RULES = 6;
const MIN_RULES = 4; // a game must pass at least 4 of the 6 checks (4/6 = Value)
const ALLOW_HOME_PICKS = true;

// Ticket tiers by score: 6/6 Ultra Safe (#1-3), 5/6 Safe (#4-7), 4/6 Value (#8-10)
const TIERS = [
  { key: 'ULTRA_SAFE', score: 6, max: 3 },
  { key: 'SAFE', score: 5, max: 4 },
  { key: 'VALUE', score: 4, max: 3 }
];

// League allowlist: id -> [country as the API writes it (lowercase letters only), name, priority]
// Priority 1 = strongest leagues (checked first), 2 = next, 3 = smaller leagues.
// The country check stops a wrong league id from letting in the wrong league.
const LEAGUES = {
  39: ['england', 'England Premier League', 1], 140: ['spain', 'Spain La Liga', 1],
  135: ['italy', 'Italy Serie A', 1], 78: ['germany', 'Germany Bundesliga', 1],
  61: ['france', 'France Ligue 1', 1], 2: ['world', 'UEFA Champions League', 1],
  3: ['world', 'UEFA Europa League', 1], 848: ['world', 'UEFA Conference League', 2],
  40: ['england', 'England Championship', 2], 88: ['netherlands', 'Netherlands Eredivisie', 2],
  94: ['portugal', 'Portugal Primeira Liga', 2], 144: ['belgium', 'Belgium Pro League', 2],
  203: ['turkey', 'Turkey Super Lig', 2], 179: ['scotland', 'Scotland Premiership', 2],
  71: ['brazil', 'Brazil Serie A', 2], 128: ['argentina', 'Argentina Liga Profesional', 2],
  253: ['usa', 'USA MLS', 2], 262: ['mexico', 'Mexico Liga MX', 2],
  307: ['saudiarabia', 'Saudi Pro League', 2], 98: ['japan', 'Japan J1 League', 2],
  13: ['world', 'Copa Libertadores', 2], 11: ['world', 'Copa Sudamericana', 3],
  79: ['germany', 'Germany 2. Bundesliga', 3], 136: ['italy', 'Italy Serie B', 3],
  141: ['spain', 'Spain Segunda Division', 3], 292: ['southkorea', 'South Korea K League 1', 3],
  169: ['china', 'China Super League', 3], 188: ['australia', 'Australia A-League', 3],
  218: ['austria', 'Austria Bundesliga', 3], 207: ['switzerland', 'Switzerland Super League', 3],
  197: ['greece', 'Greece Super League', 3], 119: ['denmark', 'Denmark Superliga', 3],
  103: ['norway', 'Norway Eliteserien', 3], 113: ['sweden', 'Sweden Allsvenskan', 3],
  106: ['poland', 'Poland Ekstraklasa', 3], 345: ['czechrepublic', 'Czech Liga', 3],
  235: ['russia', 'Russia Premier League', 3], 333: ['ukraine', 'Ukraine Premier League', 3]
};
const cleanCountry = (c) => String(c || '').toLowerCase().replace(/[^a-z]/g, '');
const INTERNATIONAL = {
  1: 'World Cup', 4: 'Euros', 9: 'Copa America', 5: 'UEFA Nations League',
  6: 'Africa Cup of Nations', 7: 'Asian Cup', 22: 'CONCACAF Gold Cup',
  32: 'WC Qualifiers Europe', 34: 'WC Qualifiers South America',
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
  out.requests_remaining = res.headers.get('x-ratelimit-requests-remaining'); // free requests left today
  if (data.errors && Object.keys(data.errors).length) throw new Error(JSON.stringify(data.errors));
  if (data.response === undefined) throw new Error('API said: ' + JSON.stringify(data).slice(0, 200));
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
  const isClub = (f) => !!LEAGUES[f.league.id] && cleanCountry(f.league.country) === LEAGUES[f.league.id][0];
  // allowlisted league id but unexpected country name: report it instead of silently skipping
  out.league_warnings = [...new Set(fixtures
    .filter((f) => LEAGUES[f.league.id] && !isClub(f))
    .map((f) => `${f.league.id} ${f.league.name} (${f.league.country})`))];
  let wanted = fixtures.filter((f) =>
    (isClub(f) || isIntl(f)) && f.fixture.status.short === 'NS' && !checked.has(f.fixture.id) &&
    !isYouthName(f.teams.home.name) && !isYouthName(f.teams.away.name));
  // best leagues first, friendlies last; same priority: earliest kick-off first
  const prio = (f) => (f.league.id === FRIENDLY_ID ? 9 : isIntl(f) ? 2 : LEAGUES[f.league.id][2]);
  wanted.sort((x, y) => prio(x) - prio(y) || Date.parse(x.fixture.date) - Date.parse(y.fixture.date));
  out.games_in_leagues = wanted.length;
  out.candidates = wanted.length;
  out.leagues_today = [...new Set(wanted.map((f) => `${f.league.id} ${f.league.name} (${f.league.country})`))];
  console.log('Leagues found today:', out.leagues_today);

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

      // Display-only fields (not a rule, no filtering): Total Average Attack and Over Display
      const attOf = (side) => {
        const a = pr.teams[side] && pr.teams[side].last_5 && pr.teams[side].last_5.att;
        return a == null || a === '' ? null : pct(a);
      };
      const attHome = attOf('home');
      const attAway = attOf('away');
      let totalAvgAttack = null;
      let overDisplay = null;
      if (attHome !== null && attAway !== null) {
        totalAvgAttack = Math.round(((attHome + attAway) / 2) * 10) / 10;
        overDisplay = totalAvgAttack >= 60 ? 'OVER 2 GOALS' : totalAvgAttack >= 30 ? 'OVER 1 GOAL' : 'No Over';
      }

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
        id: f.fixture.id, league: f.league.name, league_id: f.league.id, country: f.league.country,
        home: f.teams.home.name, away: f.teams.away.name,
        time: f.fixture.date, pick, pick_team: me.name, odd,
        score, total_rules: TOTAL_RULES, failed_rules: failed,
        form, strength, h2h_wins: wins, attack: att, avg_scored: avgFor,
        attack_home: attHome, attack_away: attAway, total_avg_attack: totalAvgAttack, over_display: overDisplay
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
  out.error = String(e.message).slice(0, 300); // shown in games.json so we can see why
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
