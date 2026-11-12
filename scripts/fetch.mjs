import { mkdirSync, writeFileSync } from 'fs';

const key = process.env.API_FOOTBALL_KEY;
const date = new Date().toISOString().slice(0, 10);

const res = await fetch(
  `https://v3.football.api-sports.io/fixtures?date=${date}`,
  { headers: { 'x-apisports-key': key } }
);
const data = await res.json();

if (data.errors && Object.keys(data.errors).length) {
  console.error(data.errors);
  process.exit(1);
}

const games = data.response.slice(0, 15).map(f => ({
  id: f.fixture.id,
  league: f.league.name,
  home: f.teams.home.name,
  away: f.teams.away.name,
  time: f.fixture.date
}));

mkdirSync('data', { recursive: true });
writeFileSync('data/games.json', JSON.stringify({ date, games }, null, 2));
console.log(`Saved ${games.length} games`);
