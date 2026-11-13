import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';

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

let FIFA = { top10: [], top49: [], aliases: {} };
if (existsSync('data/fifa.json')) {
  try { FIFA = JSON.parse(readFileSync('data/fifa.json', 'utf8')); } catch (e) {}
}
const norm = (n) => {
  const k = String(n || '').toLowerCase().trim();
  return (FIFA.aliases && FIFA.aliases[k]) || k;
};
const TOP10 = new Set((FIFA.top10 || []).map(norm));
const TOP49 = new Set((FIFA.top49 || []).map(norm));
// FIXED: if list empty, do NOT reject - return false
const isTop10 = (name) => TOP10.size > 0 && TOP10.has(norm(name));
const isRank50Plus = (name) => TOP49.size > 0 && !TOP49.has(norm(name));
const hasFifaData = TOP10.size > 0 || TOP49.size > 0;

// Youth (U15-U23) and women's teams are not allowed
const isYouthName = (n) =>
  /\bU-?(15|16|17|18|19|20|21|23)\b/i.test(n) || /\bwomen\b/i.test(n) || /\sW$/.test(n);

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
    .filter(f => ['FT', 'AET
