import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';

const KEY = process.env.API_FOOTBALL_KEY;
const BASE = 'https://v3.football.api-sports.io';
const MAX_REQUESTS = 30;
const TOTAL_RULES = 6;
const MIN_RULES = 4; // a game must pass at least 4 of the 6 checks (4/6 = Value)
const ALLOW_HOME_PICKS = false;

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

let FIFA = { top10: [], top49: [], aliases: {} };
if (existsSync('data/fifa.json')) FIFA = JSON.parse(readFileSync('data/fifa.json', 'utf8'));
const norm = (n) => {
  const k = String(n || '').toLowerCase().trim();
  return (FIFA.aliases && FIFA.aliases[k]) || k;
};
const TOP10 = new Set(FIFA.top10.map(norm));
const TOP49 = new Set(FIFA.top49.map(norm));
const isTop10 = (name) => TOP10.has(norm(name));
const isRank50Plus = (name) => !TOP49.has(norm(name));

let used = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const count = (a, x) => a.filter(v => v === x).length;

async function api(path) {
  if (used >= MAX_REQUESTS) throw new Error('LIMIT');
  if (used > 0) await sleep(6500);
  used++;
  const res = await fetch(BASE + path, { headers: { 'x-apisports-key': KEY } });
  const data = await res.json();
  if (data.errors && Object.keys(data.errors).length) throw new Error(JSON.stringify(data.errors));
  return data.response;
}

function summarize(fixtures, teamId) {
  const done = fixtures
    .filter(f => ['FT', 'AET', 'PEN'].includes(f.fixture.status.short) && f.goals.home !== null)
    .sort((a, b) => b.fixture.timestamp - a.fixture.timestamp)
    .map(f => {
      const home = f.teams.home.id === teamId;
      const gf = home ? f.goals.home : f.goals.away;
      const ga = home ? f.goals.away : f.goals.home;
      return { home, gf, ga, res: gf > ga ? 'W' : gf < ga ? 'L' : 'D' };
    });
  const last5 = done.slice(0, 5);
  return {
    results: last5.map(x => x.res),
    scored: last5.map(x => x.gf),
    conceded: last5.map(x => x.ga),
    home4: done.filter(x => x.home).slice(0, 4).map(x => x.res),
    away4: done.filter(x => !x.home).slice(0, 4).map(x => x.res)
  };
}

// The 6 checks
const ruleForm = r => count(r, 'W') >= 3 && !r.some((v, i) => v === 'L' && r[i + 1] === 'L'); // R1
const ruleVenue = (res) => count(res, 'W') >= 3;                                               // R2 (home or away, by pick)
const ruleH2H = h => count(h, 'W') >= 2;                                                       // R3
const ruleGoals = s => s.filter(g => g >= 2).length >= 3;                                      // R4
const ruleOdds = o => o >= 1.2 && o <= 1.5;                                                    // R5
const ruleTotalGoals = s => s.reduce((a, b) => a + b, 0) >= 8;                                 // R6

const date = new Date().toISOString().slice(0, 10);
const out = {
  date, generated_at: new Date().toISOString(),
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
  const isIntl = f => INTERNATIONAL[f.league.id] !== undefined;
  const wanted = fixtures.filter(f =>
    (LEAGUES[f.league.id] || isIntl(f)) && f.fixture.status.short === 'NS' && !checked.has(f.fixture.id));
  out.games_in_leagues = wanted.length;
  console.log('Leagues found today:', [...new Set(wanted.map(f => `${f.league.id} ${f.league.name} (${f.league.country})`))]);

  const standings = {};
  const clubWanted = wanted.filter(f => !isIntl(f));
  for (const lid of new Set(clubWanted.map(f => f.league.id))) {
    const season = clubWanted.find(f => f.league.id === lid).league.season;
    try {
      const r = await api(`/standings?league=${lid}&season=${season}`);
      for (const g of (r[0]?.league.standings || [])) {
        for (const t of g) standings[`${lid}-${t.team.id}`] = { rank: t.rank, n: g.length };
      }
    } catch (e) {
      if (e.message === 'LIMIT') break;
      console.log('standings failed', lid, e.message);
    }
  }

  // Entry gate: league position (clubs) or FIFA ranking (internationals) picks the team
  const candidates = [];
  for (const f of wanted) {
    const label = `${f.teams.home.name} v ${f.teams.away.name}`;
    let pick = null;
    if (isIntl(f)) {
      if (!FIFA.top10.length) { reject(label, 'no FIFA ranking file'); continue; }
      if (isTop10(f.teams.away.name) && isRank50Plus(f.teams.home.name)) pick = 'away';
      if (!pick) { reject(label, 'entry gate: FIFA ranking'); continue; }
    } else {
      const h = standings[`${f.league.id}-${f.teams.home.id}`];
      const a = standings[`${f.league.id}-${f.teams.away.id}`];
      if (!h || !a) { reject(label, 'no standings'); continue; }
      const bottom6 = x => x.rank >= x.n - 5;
      if (a.rank <= 4 && bottom6(h)) pick = 'away';
      else if (ALLOW_HOME_PICKS && h.rank <= 4 && bottom6(a)) pick = 'home';
      if (!pick) { reject(label, 'entry gate: league positions'); continue; }
    }
    candidates.push({ f, pick });
  }
  out.candidates = candidates.length;

  candidates.sort((x, y) =>
    (x.f.league.id === FRIENDLY_ID ? 1 : 0) - (y.f.league.id === FRIENDLY_ID ? 1 : 0));

  for (const { f, pick } of candidates) {
    const label = `${f.teams.home.name} v ${f.teams.away.name}`;
    if (f.league.id === FRIENDLY_ID && out.passed.length > 0) {
      reject(label, 'friendly skipped (other games passed)');
      continue;
    }
    try {
      const me = pick === 'away' ? f.teams.away : f.teams.home;
      const opp = pick === 'away' ? f.teams.home : f.teams.away;

      const odds = await api(`/odds?fixture=${f.fixture.id}&bet=1`);
      const vals = [];
      for (const bm of (odds[0]?.bookmakers || [])) {
        const bet = bm.bets.find(b => b.id === 1);
        const v = bet?.values.find(x => x.value === (pick === 'home' ? 'Home' : 'Away'));
        if (v) vals.push(parseFloat(v.odd));
      }
      if (!vals.length) { reject(label, 'no odds'); continue; }
      const odd = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;

      const mine = summarize(await api(`/fixtures?team=${me.id}&last=15`), me.id);
      if (mine.results.length < 5 || mine.home4.length < 4 || mine.away4.length < 4) {
        reject(label, 'not enough history'); continue;
      }
      const h2h = summarize(await api(`/fixtures/headtohead?h2h=${me.id}-${opp.id}&last=3`), me.id).results;

      // Score the 6 checks (true = passed)
      const r = {
        1: ruleForm(mine.results),
        2: ruleVenue(pick === 'home' ? mine.home4 : mine.away4),
        3: ruleH2H(h2h),
        4: ruleGoals(mine.scored),
        5: ruleOdds(odd),
        6: ruleTotalGoals(mine.scored)
      };
      const failed = Object.keys(r).filter(k => !r[k]).map(Number);
      const score = TOTAL_RULES - failed.length;
      if (score < MIN_RULES) {
        reject(label, `only ${score}/${TOTAL_RULES} (failed R${failed.join(', R')})`);
        continue;
      }

      out.passed.push({
        id: f.fixture.id, league: f.league.name,
        home: f.teams.home.name, away: f.teams.away.name,
        time: f.fixture.date, pick, pick_team: me.name, odd,
        score, total_rules: TOTAL_RULES, failed_rules: failed
      });
    } catch (e) {
      if (e.message === 'LIMIT') { limitHit = true; reject(label, 'request limit reached'); break; }
      reject(label, 'error ' + e.message);
    } finally {
      if (!limitHit) checked.add(f.fixture.id);
    }
  }
} catch (e) {
  console.log('Stopped early:', e.message);
}

const seen = new Set();
out.rejected = out.rejected.filter(r => {
  const k = r.game + '|' + r.why;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

// Best score first, then lowest odd
out.passed.sort((a, b) => (b.score || 0) - (a.score || 0) || a.odd - b.odd);

// Build tickets by score tier (once a ticket is made for the day it is kept)
for (const t of TIERS) {
  if (out.tickets[t.key]) continue;
  const games = out.passed.filter(g => g.score === t.score).slice(0, t.max);
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
