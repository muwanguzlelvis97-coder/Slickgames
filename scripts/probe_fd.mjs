import { mkdirSync, writeFileSync } from 'node:fs';

// Test of the football-data.org FREE plan. Writes data/probe_fd.json. Uses 4 requests.
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
    return { status: res.status, left_this_minute: res.headers.get('x-requests-available-minute'), body };
  } catch (e) {
    return { status: 0, error: String(e), body: null };
  }
}
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const out = { generated_at: new Date().toISOString(), tests: [] };
const fail = (r) => (r.status >= 200 && r.status < 300 ? null : (r.body && r.body.message) || r.error || 'HTTP ' + r.status);

// 1. matches in the next 10 days (all competitions in the free plan)
const m = await call(`/matches?dateFrom=${day(0)}&dateTo=${day(9)}`);
const matches = (m.body && m.body.matches) || [];
out.tests.push({
  test: 'matches next 10 days', status: m.status, error: fail(m), left_this_minute: m.left_this_minute,
  count: matches.length,
  sample: matches.slice(0, 8).map((x) => `${x.utcDate} | ${x.competition && x.competition.code} | ${x.homeTeam && x.homeTeam.name} v ${x.awayTeam && x.awayTeam.name} | ${x.status}`)
});

const first = matches.find((x) => x.status === 'TIMED' || x.status === 'SCHEDULED') || matches[0];
if (first) {
  const label = `${first.homeTeam.name} v ${first.awayTeam.name}`;
  // 2. finished matches of the home team (for form, home record, goals)
  const t = await call(`/teams/${first.homeTeam.id}/matches?status=FINISHED&limit=12`);
  const tm = (t.body && t.body.matches) || [];
  out.tests.push({
    test: 'team finished matches', game: label, status: t.status, error: fail(t),
    count: tm.length,
    sample: tm.slice(-6).map((x) => `${x.utcDate.slice(0, 10)} | ${x.competition && x.competition.code} | ${x.homeTeam.name} ${x.score && x.score.fullTime && x.score.fullTime.home}-${x.score && x.score.fullTime && x.score.fullTime.away} ${x.awayTeam.name}`)
  });
  // 3. head to head
  const h = await call(`/matches/${first.id}/head2head?limit=5`);
  const hm = (h.body && h.body.matches) || [];
  out.tests.push({
    test: 'head to head', game: label, status: h.status, error: fail(h),
    count: hm.length,
    sample: hm.slice(0, 5).map((x) => `${x.utcDate.slice(0, 10)} | ${x.homeTeam.name} ${x.score && x.score.fullTime && x.score.fullTime.home}-${x.score && x.score.fullTime && x.score.fullTime.away} ${x.awayTeam.name}`)
  });
  // 4. same team, previous season
  const p = await call(`/teams/${first.homeTeam.id}/matches?status=FINISHED&season=${new Date().getUTCFullYear() - 1}&limit=5`);
  out.tests.push({ test: 'team matches previous season', status: p.status, error: fail(p), count: ((p.body && p.body.matches) || []).length });
} else {
  out.tests.push({ test: 'no match found in the next 10 days for the free competitions' });
}

out.requests_used = used;
mkdirSync('data', { recursive: true });
writeFileSync('data/probe_fd.json', JSON.stringify(out, null, 2));
console.log('Probe done. Requests used:', used);
