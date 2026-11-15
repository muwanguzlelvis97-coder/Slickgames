import { mkdirSync, writeFileSync } from 'node:fs';

// Test 2 of the football-data.org FREE plan. Writes data/probe_fd.json. Uses 5 requests.
const KEY = process.env.FOOTBALL_DATA_KEY;
const BASE = 'https://api.football-data.org/v4';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let used = 0;

async function call(path) {
  if (used > 0) await sleep(7000); // free plan: 10 requests a minute
  used++;
  try {
    const res = await fetch(BASE + path, { headers: { 'X-Auth-Token': KEY || '' } });
    let body = null;
    try { body = await res.json(); } catch (e) {}
    return { path, status: res.status, body };
  } catch (e) {
    return { path, status: 0, error: String(e), body: null };
  }
}
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const fail = (r) => (r.status >= 200 && r.status < 300 ? null : (r.body && r.body.message) || r.error || 'HTTP ' + r.status);
const line = (x) => `${x.utcDate} | ${x.competition && x.competition.code} | ${x.homeTeam && x.homeTeam.name} ${x.score && x.score.fullTime && x.score.fullTime.home != null ? x.score.fullTime.home + '-' + x.score.fullTime.away : 'v'} ${x.awayTeam && x.awayTeam.name} | ${x.status}`;
const out = { generated_at: new Date().toISOString(), tests: [] };
const add = (name, r, list, n) => out.tests.push({
  test: name, path: r.path, status: r.status, error: fail(r),
  count: list ? list.length : undefined,
  sample: list ? list.slice(n < 0 ? n : 0, n < 0 ? undefined : n).map(line) : undefined
});

// 1. scheduled Premier League matches (are future fixtures visible?)
const a = await call('/competitions/PL/matches?status=SCHEDULED');
const al = (a.body && a.body.matches) || [];
add('PL scheduled matches', a, al, 4);

// 2. all competitions, a past week (does the date filter work at all?)
const b = await call(`/matches?dateFrom=${day(-9)}&dateTo=${day(-4)}`);
const bl = (b.body && b.body.matches) || [];
add('matches last week, all competitions', b, bl, 6);

// 3. a team's finished matches (Arsenal, id 57)
const c = await call('/teams/57/matches?status=FINISHED&limit=12');
const cl = (c.body && c.body.matches) || [];
add('Arsenal finished matches', c, cl, -6);

// 4. head to head for the first scheduled PL match
const first = al[0];
if (first) {
  const d = await call(`/matches/${first.id}/head2head?limit=5`);
  const dl = (d.body && d.body.matches) || [];
  add('head to head ' + first.homeTeam.name + ' v ' + first.awayTeam.name, d, dl, 5);
}

// 5. same week range but only Premier League + Championship + La Liga
const e = await call(`/matches?competitions=PL,ELC,PD&dateFrom=${day(-9)}&dateTo=${day(-4)}`);
const el = (e.body && e.body.matches) || [];
add('matches last week, PL+ELC+PD only', e, el, 4);

out.requests_used = used;
mkdirSync('data', { recursive: true });
writeFileSync('data/probe_fd.json', JSON.stringify(out, null, 2));
console.log('Probe done. Requests used:', used);
