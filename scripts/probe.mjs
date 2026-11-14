import { mkdirSync, writeFileSync } from 'node:fs';

const KEY = process.env.API_FOOTBALL_KEY;
const BASE = 'https://v3.football.api-sports.io';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let used = 0;

async function call(path) {
  if (used > 0) await sleep(6500);
  used++;
  try {
    const res = await fetch(BASE + path, { headers: { 'x-apisports-key': KEY } });
    const data = await res.json();
    const err = data.errors && Object.keys(data.errors).length ? JSON.stringify(data.errors) : null;
    return { ok: !err, error: err, response: data.response };
  } catch (e) {
    return { ok: false, error: String(e), response: null };
  }
}

const date = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
const out = { date, generated_at: new Date().toISOString(), requests_used: 0, tests: [] };
const youth = (n) => /\bU-?(15|16|17|18|19|20|21|23)\b/i.test(n) || /\bwomen\b/i.test(n);

const day = await call(`/fixtures?date=${date}`);
if (!day.ok) {
  out.tests.push({ test: 'fixtures of the day', ok: false, error: day.error });
} else {
  const games = (day.response || [])
    .filter((f) => f.fixture.status.short === 'NS' && !youth(f.teams.home.name) && !youth(f.teams.away.name))
    .slice(0, 2);
  out.tests.push({ test: 'fixtures of the day', ok: true, games_found: (day.response || []).length });

  for (const f of games) {
    const game = `${f.teams.home.name} v ${f.teams.away.name}`;
    const h = f.teams.home.id;
    const a = f.teams.away.id;

    // 1. Predictions endpoint (form + goals already calculated by the API)
    const p = await call(`/predictions?fixture=${f.fixture.id}`);
    const pr = p.response && p.response[0];
    out.tests.push({
      game, test: 'predictions', ok: p.ok, error: p.error,
      sample: pr ? {
        advice: pr.predictions && pr.predictions.advice,
        comparison: pr.comparison,
        home_last5: pr.teams && pr.teams.home && pr.teams.home.last_5,
        away_last5: pr.teams && pr.teams.away && pr.teams.away.last_5,
        h2h_count: (pr.h2h || []).length,
        h2h_latest: (pr.h2h || []).slice(0, 3).map((m) => m.fixture.date.slice(0, 10))
      } : null
    });

    // 2. Head to head with no season
    const hh = await call(`/fixtures/headtohead?h2h=${h}-${a}`);
    const list = (hh.response || []).map((m) => m.fixture.date.slice(0, 10)).sort().reverse();
    out.tests.push({
      game, test: 'head to head', ok: hh.ok, error: hh.error,
      sample: { matches: list.length, newest: list.slice(0, 3) }
    });

    // 3. Team statistics for the current season
    const ts = await call(`/teams/statistics?league=${f.league.id}&season=${f.league.season}&team=${h}`);
    out.tests.push({
      game, test: 'team statistics', ok: ts.ok, error: ts.error,
      sample: ts.response && !Array.isArray(ts.response)
        ? { form: ts.response.form, played: ts.response.fixtures && ts.response.fixtures.played }
        : null
    });
  }
}

out.requests_used = used;
mkdirSync('data', { recursive: true });
writeFileSync('data/probe.json', JSON.stringify(out, null, 2));
console.log('Probe done. Requests used:', used);
