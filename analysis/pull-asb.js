// aussportsbetting.com historical results + BOOKMAKER odds (open AND close),
// AFL & NRL, 2009-present. The opening price is the honest "what we'd actually
// lock days out" bet price — much more realistic than betting into the sharp
// exchange close — and pairing it with the close lets us measure real CLV.
// Bookmaker odds carry vig (~5-8%), which is exactly what a punter pays.
//
//   node analysis/pull-asb.js nrl|afl
//   import { pullAsb } from './pull-asb.js'
//
// The file is an .xlsx (a zip of XML); we parse it with `unzip` + regex, no deps.

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalTeam } from './lib/nrl_teams.js';
import { canonicalAflTeam } from './lib/afl_teams.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, 'cache');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
// NOTE: in the aussportsbetting AFL file the "Home Odds Open" / "Away Odds Open"
// columns are transposed (verified: open-home vs close-home correlate −0.99, and
// swapping fixes it to +0.99). The close columns are correct. NRL is fine.
const LEAGUES = { nrl: { team: canonicalTeam, swapOpen: false }, afl: { team: canonicalAflTeam, swapOpen: true } };

const excelToMs = (n) => Date.UTC(1899, 11, 30) + Number(n) * 86400000;
function colNum(ref) { const m = ref.match(/^([A-Z]+)/)[1]; let n = 0; for (const ch of m) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }

async function loadRows(league) {
  const file = path.join(CACHE, `asb_${league}.xlsx`);
  try { await fs.access(file); } catch {
    const r = await fetch(`https://www.aussportsbetting.com/historical_data/${league}.xlsx`, { headers: { 'user-agent': UA } });
    if (!r.ok) throw new Error(`ASB ${league}: HTTP ${r.status}`);
    await fs.mkdir(CACHE, { recursive: true });
    await fs.writeFile(file, Buffer.from(await r.arrayBuffer()));
  }
  const ss = execFileSync('unzip', ['-p', file, 'xl/sharedStrings.xml'], { encoding: 'utf8', maxBuffer: 1e8 });
  const strings = [...ss.matchAll(/<si>(.*?)<\/si>/gs)].map((m) => [...m[1].matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map((x) => x[1]).join('').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
  const sheet = execFileSync('unzip', ['-p', file, 'xl/worksheets/sheet1.xml'], { encoding: 'utf8', maxBuffer: 1e8 });
  return [...sheet.matchAll(/<row[^>]*>(.*?)<\/row>/gs)].map((r) => {
    const a = [];
    for (const m of r[1].matchAll(/<c\s+r="([A-Z]+\d+)"([^>]*?)(?:\/>|>(.*?)<\/c>)/gs)) {
      const v = (m[3] || '').match(/<v>(.*?)<\/v>/s);
      a[colNum(m[1])] = v ? (/t="s"/.test(m[2] || '') ? strings[Number(v[1])] : v[1]) : '';
    }
    return a;
  });
}

// Column layout (verified 3 Jul 2026): 0 Date, 2 Home, 3 Away, 4 Venue,
// 5 HomeScore, 6 AwayScore, 13 Home Open, 16 Home Close, 17 Away Open, 20 Away Close.
export async function pullAsb(league) {
  const { team, swapOpen } = LEAGUES[league];
  const rows = await loadRows(league);
  const num = (x) => { const v = Number(x); return Number.isFinite(v) && v > 1 ? v : null; };
  const out = [];
  for (const c of rows) {
    if (!c[0] || !/^\d/.test(String(c[0]))) continue; // not a data row
    const home = team(c[2]), away = team(c[3]);
    if (!home || !away || home === away) continue;
    const hs = Number(c[5]), as = Number(c[6]);
    if (!Number.isFinite(hs) || !Number.isFinite(as) || hs === as) continue; // drop draws
    const homeOpen = num(swapOpen ? c[17] : c[13]), awayOpen = num(swapOpen ? c[13] : c[17]);
    const homeClose = num(c[16]), awayClose = num(c[20]);
    if (!homeOpen || !awayOpen) continue; // need an opening price to bet at
    const dateMs = excelToMs(c[0]);
    out.push({
      league, dateMs, date: new Date(dateMs).toISOString().slice(0, 10),
      season: new Date(dateMs).getUTCFullYear(),
      home, away, venue: c[4] || null, homeScore: hs, awayScore: as, homeWin: hs > as ? 1 : 0,
      homeOpen, awayOpen, homeClose, awayClose,
    });
  }
  out.sort((a, b) => a.dateMs - b.dateMs);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const league = (process.argv[2] || 'nrl').toLowerCase();
  const m = await pullAsb(league);
  const withClose = m.filter((x) => x.homeClose && x.awayClose).length;
  const y = {}; m.forEach((x) => { y[x.season] = (y[x.season] || 0) + 1; });
  console.log(`${league.toUpperCase()}: ${m.length} matches with opening odds`, y);
  console.log(`with closing odds too (for CLV): ${withClose}`);
  console.log('2026 sample:', JSON.stringify(m.filter((x) => x.season === 2026)[0]));
}
