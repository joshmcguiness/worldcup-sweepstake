// Fetch the inputs for the MLB pitcher-and-lineup calls from the public MLB
// Stats API (statsapi.mlb.com — no key) and The Odds API / ESPN for prices.
// Everything is best-effort: a missing piece degrades to a sensible default
// inside public/lib/mlbtips.js rather than failing the build.
import { readFileSync, existsSync } from 'node:fs';
import { rollMlbTips } from '../public/lib/mlbtips.js';

const API = 'https://statsapi.mlb.com/api/v1';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
async function getJson(url, timeoutMs = 15000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try { const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': UA } }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.json(); }
  finally { clearTimeout(t); }
}
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const DAY = 86400e3;
const GAME_TYPES = 'R,F,D,L,W'; // regular season + every postseason round

async function pitcherLine(id, season) {
  if (!id) return null;
  for (const yr of [season, season - 1]) {
    try {
      const [p, st] = await Promise.all([
        getJson(`${API}/people/${id}`),
        getJson(`${API}/people/${id}/stats?stats=season,statSplits&group=pitching&season=${yr}&sitCodes=vl,vr`),
      ]);
      const person = (p.people || [])[0] || {};
      const season0 = (st.stats || []).find((s) => s.type.displayName === 'season');
      const line = season0 && season0.splits[0] && season0.splits[0].stat;
      if (!line || !(parseFloat(line.inningsPitched) > 0)) continue;
      const splits = (st.stats || []).find((s) => s.type.displayName === 'statSplits');
      const sp = (code) => { const x = (splits ? splits.splits : []).find((s) => s.split.code === code); return x ? { ops: parseFloat(x.stat.ops) || 0, pa: x.stat.battersFaced || 0 } : { ops: 0, pa: 0 }; };
      return { id, name: person.fullName || String(id), hand: person.pitchHand ? person.pitchHand.code : 'R', season: yr,
        ip: parseFloat(line.inningsPitched), gs: line.gamesStarted || 0, hr: line.homeRuns || 0, bb: line.baseOnBalls || 0, hbp: line.hitByPitch || 0, so: line.strikeOuts || 0, era: line.era,
        vsL: sp('vl'), vsR: sp('vr') };
    } catch { /* try prior season */ }
  }
  return null;
}
async function teamLine(id, season) {
  for (const yr of [season, season - 1]) {
    try {
      const st = await getJson(`${API}/teams/${id}/stats?stats=season,statSplits&group=hitting&season=${yr}&sitCodes=vl,vr`);
      const season0 = (st.stats || []).find((s) => s.type.displayName === 'season');
      const line = season0 && season0.splits[0] && season0.splits[0].stat;
      if (!line || !(line.gamesPlayed > 0)) continue;
      const splits = (st.stats || []).find((s) => s.type.displayName === 'statSplits');
      const sp = (code) => { const x = (splits ? splits.splits : []).find((s) => s.split.code === code); return { ops: x ? parseFloat(x.stat.ops) || 0 : 0 }; };
      return { rpg: line.runs / line.gamesPlayed, ops: parseFloat(line.ops) || 0, vs: { L: sp('vl'), R: sp('vr') } };
    } catch { /* try prior season */ }
  }
  return { rpg: 0, ops: 0, vs: { L: { ops: 0 }, R: { ops: 0 } } };
}
async function batSides(ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 40) {
    try { const j = await getJson(`${API}/people?personIds=${ids.slice(i, i + 40).join(',')}&hydrate=batSide`); (j.people || []).forEach((p) => { out[p.id] = p.batSide ? p.batSide.code : 'R'; }); } catch { /* default R */ }
  }
  return out;
}
// Relief usage over the last three days for every team that played.
async function bullpenUsage(now) {
  const from = iso(now - 3 * DAY), to = iso(now);
  const usage = {};
  try {
    const s = await getJson(`${API}/schedule?sportId=1&startDate=${from}&endDate=${to}&gameTypes=${GAME_TYPES}`);
    const pks = [];
    for (const d of s.dates || []) for (const g of d.games) if (g.status && g.status.abstractGameState === 'Final') pks.push({ pk: g.gamePk, t: Date.parse(d.date + 'T12:00:00Z') });
    for (const { pk, t } of pks.slice(0, 60)) {
      try {
        const b = await getJson(`${API}/game/${pk}/boxscore`);
        for (const side of ['away', 'home']) {
          const tm = b.teams[side]; const list = (usage[tm.team.id] = usage[tm.team.id] || []);
          (tm.pitchers || []).forEach((pid, i) => { const p = tm.players['ID' + pid]; const st = (p && p.stats && p.stats.pitching) || {}; list.push({ role: i === 0 ? 'SP' : 'RP', name: p ? p.person.fullName : String(pid), t, pitches: st.numberOfPitches || st.pitchesThrown || 0 }); });
        }
      } catch { /* skip one box */ }
    }
  } catch { /* no usage -> no fatigue */ }
  return usage;
}
async function marketPrices(oddsKey) {
  const byKey = {};
  const usDate = (t) => new Date(t - 8 * 3600e3).toISOString().slice(0, 10);
  const keyOf = (home, away, t) => `${usDate(t)}|${home}|${away}`.toLowerCase().replace(/[^a-z0-9|-]/g, '');
  if (oddsKey) {
    try {
      const ev = await getJson(`https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?regions=au,us&markets=h2h&oddsFormat=decimal&apiKey=${encodeURIComponent(oddsKey)}`);
      for (const e of ev || []) {
        const h = [], a = [];
        for (const bk of e.bookmakers || []) for (const mk of bk.markets || []) if (mk.key === 'h2h') for (const o of mk.outcomes || []) { if (o.name === e.home_team && o.price > 1) h.push(o.price); if (o.name === e.away_team && o.price > 1) a.push(o.price); }
        if (h.length && a.length) byKey[keyOf(e.home_team, e.away_team, Date.parse(e.commence_time))] = { home: h.reduce((x, y) => x + y) / h.length, away: a.reduce((x, y) => x + y) / a.length, src: 'odds-api' };
      }
      if (Object.keys(byKey).length) return { byKey, keyOf };
    } catch { /* fall through to ESPN */ }
  }
  // ESPN fallback: only the favourite's money line is in 'details' ("NYY -174")
  for (const d of [0, 1, 2]) {
    try {
      const day = new Date(Date.now() + d * DAY).toISOString().slice(0, 10).replace(/-/g, '');
      const j = await getJson(`https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=${day}`);
      for (const e of j.events || []) {
        const c = e.competitions[0]; const o = (c.odds || [])[0]; if (!o || !o.details) continue;
        const home = c.competitors.find((x) => x.homeAway === 'home'), away = c.competitors.find((x) => x.homeAway === 'away');
        const m = /^([A-Z]+) ([-+]\d+)$/.exec(o.details.trim()); if (!m) continue;
        const favHome = m[1] === home.team.abbreviation; const ml = Number(m[2]);
        const favDec = ml < 0 ? 1 + 100 / -ml : 1 + ml / 100; const dogDec = 1 / Math.max(0.05, 1.045 - 1 / favDec);
        byKey[keyOf(home.team.displayName, away.team.displayName, Date.parse(e.date))] = favHome ? { home: favDec, away: dogDec, src: 'espn' } : { home: dogDec, away: favDec, src: 'espn' };
      }
    } catch { /* no prices that day */ }
  }
  return { byKey, keyOf };
}

export async function buildMlbTips(prev, oddsKey, notes, now = Date.now()) {
  const season = new Date(now).getUTCFullYear();
  const from = iso(now - 2 * DAY), to = iso(now + 2 * DAY);
  const sched = await getJson(`${API}/schedule?sportId=1&startDate=${from}&endDate=${to}&hydrate=probablePitcher,lineups,team&gameTypes=${GAME_TYPES}`);
  const results = {}, upcoming = [];
  for (const d of sched.dates || []) for (const g of d.games) {
    const st = g.status || {};
    if (st.abstractGameState === 'Final') results[g.gamePk] = { final: true, hs: g.teams.home.score, as: g.teams.away.score };
    else if (Date.parse(g.gameDate) > now && st.abstractGameState !== 'Live') upcoming.push(g);
  }
  // settle anything pending that fell outside the window (long-ago gamePks)
  const pendingPks = (prev && prev.tips ? prev.tips : []).filter((t) => t.status === 'pending' && !results[t.gamePk]).map((t) => t.gamePk);
  for (const pk of pendingPks.slice(0, 20)) {
    try { const j = await getJson(`${API}/schedule?sportId=1&gamePk=${pk}`); const g = j.dates && j.dates[0] && j.dates[0].games[0]; if (g && g.status.abstractGameState === 'Final') results[pk] = { final: true, hs: g.teams.home.score, as: g.teams.away.score }; } catch { /* stays pending */ }
  }
  const [usage, prices] = await Promise.all([bullpenUsage(now), marketPrices(oddsKey)]);
  const teamCache = {}, spCache = {};
  const games = [];
  for (const g of upcoming.slice(0, 20)) {
    const hT = g.teams.home.team, aT = g.teams.away.team;
    const hSpId = g.teams.home.probablePitcher && g.teams.home.probablePitcher.id, aSpId = g.teams.away.probablePitcher && g.teams.away.probablePitcher.id;
    const [homeSP, awaySP, homeTeam, awayTeam] = await Promise.all([
      hSpId ? (spCache[hSpId] = spCache[hSpId] || pitcherLine(hSpId, season)) : null,
      aSpId ? (spCache[aSpId] = spCache[aSpId] || pitcherLine(aSpId, season)) : null,
      (teamCache[hT.id] = teamCache[hT.id] || teamLine(hT.id, season)),
      (teamCache[aT.id] = teamCache[aT.id] || teamLine(aT.id, season)),
    ]);
    const lu = g.lineups || {};
    const ids = [...(lu.homePlayers || []), ...(lu.awayPlayers || [])].map((p) => p.id);
    const sides = ids.length ? await batSides(ids) : {};
    const lineup = (arr) => (arr && arr.length ? arr.map((p) => ({ name: p.fullName, bats: sides[p.id] || 'R' })) : null);
    games.push({
      gamePk: g.gamePk, home: hT.name, away: aT.name, kickoff: g.gameDate, t: Date.parse(g.gameDate),
      series: g.seriesDescription || (g.gameType === 'R' ? 'Regular season' : g.gameType), gameNo: g.seriesGameNumber || null,
      homeSP, awaySP, homeTeam, awayTeam, homeLineup: lineup(lu.homePlayers), awayLineup: lineup(lu.awayPlayers),
      homeUsage: usage[hT.id] || [], awayUsage: usage[aT.id] || [],
      prices: prices.byKey[prices.keyOf(hT.name, aT.name, Date.parse(g.gameDate))] || null,
    });
  }
  // seed the hand-written calls (one-off, 8 Oct 2026 Division Series)
  let seeded = prev;
  const manualPath = new URL('../config/mlb-manual-tips.json', import.meta.url);
  if (existsSync(manualPath)) {
    try {
      const manual = JSON.parse(readFileSync(manualPath, 'utf8'));
      const have = new Set(((prev && prev.tips) || []).map((t) => t.id));
      const add = manual.filter((t) => !have.has(t.id));
      if (add.length) seeded = { ...(prev || {}), tips: [...((prev && prev.tips) || []), ...add] };
    } catch { /* ignore a bad seed file */ }
  }
  const out = rollMlbTips(seeded, { games, results, now });
  notes.push(`MLB pitcher calls: ${games.length} upcoming games evaluated, ${out.preview.filter((p) => p.qualifies).length} qualify, prices via ${games.find((g) => g.prices) ? games.find((g) => g.prices).prices.src : 'none'}`);
  return out;
}
