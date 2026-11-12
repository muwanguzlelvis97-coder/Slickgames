import { mkdirSync, writeFileSync } from 'fs';

const KEY = process.env.API_FOOTBALL_KEY;
const BASE = 'https://v3.football.api-sports.io';
const MAX_REQUESTS = 90;
const ALLOW_HOME_PICKS = false;

const LEAGUES = {
  39: 'England Premier League',
  40: 'England Championship',
  78: 'Germany Bundesliga',
  88: 'Netherlands Eredivisie',
  94: 'Portugal Primeira Liga',
  144: 'Belgium Pro League',
  253: 'USA MLS'
};

let used = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const count = (a, x) => a.filter(v => v === x).length;

async function api(path) {
  if (used >= MAX_REQUESTS) throw new Error('LIMIT');
  if (used > 0) await sleep(6500);
  used++;
  const res = await fetch(BASE + path, { headers: { 'x-apisports-key': KEY } });
  const data = await res.json();
  if (data.errors && Object.keys(data.errors).length) {
    throw new Error(JSON.stringify(data.errors));
  }
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

const ruleForm = r => count(r, 'W') >= 3 && !r.some((v, i) => v === 'L' && r[i + 1] === 'L');
const ruleGoals = s => s.filter(g => g >= 2).length >= 3;
const ruleScoredDefended = (s, c) =>
  s.reduce((a, b) => a + b, 0) >= 8 && s.filter(g => g > 0).length >= 4 &&
  c.reduce((a, b) => a + b, 0) <= 5 && c.filter(g => g === 0).length >= 2;

const date = new Date().toISOString().slice(0, 10);
const out = {
  date, generated_at: new Date().toISOString(),
  games_in_leagues: 0, candidates: 0, requests_used: 0,
  passed: [], tickets: {}, rejected: []
};
const reject = (game, why) => out.rejected.push({ game, why });

const fixtures = await api(`/fixtures?date=${date}`);
const wanted = fixtures.filter(f => LEAGUES[f.league.id] && f.fixture.status.short === 'NS');
out.games_in_leagues = wanted.length;
console.log('Leagues found today:', [...new Set(wanted.map(f => `${f.league.id} ${f.league.name} (${f.league.country})`))]);

try {
  const standings = {};
  for (const lid of new Set(wanted.map(f => f.league.id))) {
    const season = wanted.find(f => f.league.id === lid).league.season;
    try {
      const r = await api(`/standings?league=${lid}&season=${season}`);
      for (const g of (r[0]?.league?.standings || [])) {
        for (const t of g) standings[`${lid}-${t.team.id}`] = { rank: t.rank, n: g.length };
      }
    } catch (e) {
      if (e.message === 'LIMIT') break;
      console.log('standings failed', lid, e.message);
    }
  }

  const candidates = [];
  for (const f of wanted) {
    const label = `${f.teams.home.name} v ${f.teams.away.name}`;
    const h = standings[`${f.league.id}-${f.teams.home.id}`];
    const a = standings[`${f.league.id}-${f.teams.away.id}`];
    if (!h || !a) { reject(label, 'no standings'); continue; }
    const bottom6 = x => x.rank >= x.n - 5;
    let pick = null;
    if (a.rank <= 4 && bottom6(h)) pick = 'away';
    else if (ALLOW_HOME_PICKS && h.rank <= 4 && bottom6(a)) pick = 'home';
    if (!pick) { reject(label, 'R3 positions'); continue; }
    candidates.push({ f, pick });
  }
  out.candidates = candidates.length;

  for (const { f, pick } of candidates) {
    const label = `${f.teams.home.name} v ${f.teams.away.name}`;
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
      if (odd < 1.2 || odd > 1.5) { reject(label, `R6 odds ${odd}`); continue; }

      const mine = summarize(await api(`/fixtures?team=${me.id}&last=15`), me.id);
      if (mine.results.length < 5 || mine.home4.length < 4 || mine.away4.length < 4) {
        reject(label, 'not enough history'); continue;
      }
      if (!ruleForm(mine.results)) { reject(label, 'R1 form'); continue; }
      if (count(mine.home4, 'W') < 3) { reject(label, 'R2 home'); continue; }
      if (count(mine.away4, 'W') < 3) { reject(label, 'R3 away form'); continue; }
      if (!ruleGoals(mine.scored)) { reject(label, 'R5 goals'); continue; }
      if (!ruleScoredDefended(mine.scored, mine.conceded)) { reject(label, 'R7 scored/defended'); continue; }

      const theirs = summarize(await api(`/fixtures?team=${opp.id}&last=15`), opp.id);
      const venue = pick === 'away' ? theirs.home4 : theirs.away4;
      if (venue.length < 4 || count(venue, 'L') < 2) { reject(label, 'R3 opponent'); continue; }

      const h2h = summarize(await api(`/fixtures/headtohead?h2h=${me.id}-${opp.id}&last=3`), me.id).results;
      if (count(h2h, 'W') < 2) { reject(label, 'R4 h2h'); continue; }

      out.passed.push({
        id: f.fixture.id, league: f.league.name,
        home: f.teams.home.name, away: f.teams.away.name,
        time: f.fixture.date, pick, pick_team: me.name, odd
      });
    } catch (e) {
      if (e.message === 'LIMIT') { reject(label, 'request limit reached'); break; }
      reject(label, 'error ' + e.message);
    }
  }
} catch (e) {
  console.log('Stopped early:', e.message);
}

out.passed.sort((a, b) => a.odd - b.odd);
const make = n => ({
  games: out.passed.slice(0, n).map(g => g.id),
  total_odds: Math.round(out.passed.slice(0, n).reduce((a, g) => a * g.odd, 1) * 100) / 100
});
if (out.passed.length >= 2) out.tickets.ULTRA_SAFE = make(2);
if (out.passed.length >= 3) out.tickets.SAFE = make(3);
if (out.passed.length >= 4) out.tickets.VALUE = make(4);

out.requests_used = used;
mkdirSync('data', { recursive: true });
writeFileSync('data/games.json', JSON.stringify(out, null, 2));
console.log(`Passed 7/7: ${out.passed.length}. Requests used: ${used}`);
