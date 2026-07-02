// Frontend: fetches data.json (written by the scheduled build) and renders all
// tabs. Render functions are ported from the prototype; the business logic
// lives in ./lib/ and is shared with the build job.
import { teamOdds } from './lib/teams.js';
import { FIX, resolveFixtures } from './lib/fixtures.js';
import { computeStandings, teamByGroupRank, resolveSlot } from './lib/standings.js';
import { predictBracket } from './lib/bracket.js';
import { poolRows, wildRows, winRows, prizeTable, rankIn, teamsOf, probFrac, amer, aud } from './lib/scoring.js';
import { CHAOS_DEFAULT_POINTS } from './lib/sidepots.js';

const AEST = 'Australia/Brisbane';
let data = null; // contents of data.json
let ctx = null;  // {teams, fixtures, players, owners, scores, buyIn, split}

/* ---------- helpers ---------- */
function esc(s) { return (s == null ? '' : String(s)).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function el(id) { return document.getElementById(id); }
function ownerOf(t) { return ctx.owners[t] || ''; }
function odds(t) { return teamOdds(ctx.teams, t); }
function pct(p, dp = 1) { return (p * 100).toFixed(dp) + '%'; }
function fmtDate(iso) {
  const d = new Date(iso);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n) => (n < 10 ? '0' : '') + n;
  return {
    utc: days[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + mon[d.getUTCMonth()] + ', ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ' UTC',
    loc: d.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
  };
}
function fmtAEST(ts) { return new Date(ts).toLocaleString('en-AU', { timeZone: AEST, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' AEST'; }

/* ---------- tabs: four groups, second row shows the active group ---------- */
const TAB_GROUPS = [
  { key: 'pool', label: '🏆 The Pool', tabs: [['today', '📅 Today'], ['board', 'Pool'], ['myteam', 'My Team'], ['summary', 'Player Summary']] },
  { key: 'bets', label: '💰 Bets & Pots', tabs: [['boot', '👟 Golden Boot Pot'], ['dark', '🐴 Dark Horse Prize'], ['pots', '🤡 Curnow Bets'], ['hrbets', '🎲 High Risk Curnow Bets'], ['learn', '📊 Results & Learnings'], ['wild', 'Goal Differential Bet'], ['pot', 'Pot & Prizes']] },
  { key: 'more', label: '🏉 More Sports Bets', tabs: [['afl', 'AFL Bets'], ['nrl', 'NRL Bets'], ['nfl', 'NFL Bets'], ['epl', 'EPL Bets']] },
  { key: 'predict', label: '🔮 Predictions', tabs: [['proj', 'Projections & Win Odds'], ['mvm', '📐 Model vs Market'], ['bracket', 'Bracket Prediction']] },
  { key: 'info', label: 'ℹ️ Info', tabs: [['fixtures', 'Fixtures & Results'], ['about', 'About & Change Log']] },
];
const TABINFO = {
  today: 'Every match today (or the next matchday) with the owner of each team badged — so you know who to cheer for.',
  myteam: 'Pick any player to see all of their teams and how each one is doing — plus the full locked draw.',
  board: 'The main competition — players ranked by their teams’ points (group results + knockout bonus). 🥇 leads, 🥄 is the wooden spoon.',
  summary: 'A one-glance dashboard for any player: where they rank across every game and which prizes they’re winning.',
  wild: 'Every player’s goals for, goals against and net score across their teams — one leaderboard.',
  proj: 'A 30,000-run tournament simulation plus the bookmaker-implied chance each player owns the champion.',
  mvm: 'The model laid bare: its probability for every upcoming priced match and the outright market, next to the bookmakers’ margin-stripped numbers — positive edge = value.',
  boot: 'Everyone drew five strikers from the bookies’ Golden Boot favourites — most combined goals wins the pot.',
  dark: 'All 48 teams by FIFA ranking. The prize goes to the owner of the eligible underdog that progresses furthest.',
  pots: 'The Chaos Pot — own goals, red cards, missed pens and keeper goals score points; the most chaotic team wins for its owner.',
  hrbets: 'Five calls that finalise today + five longer-range calls, each explained and carrying a virtual $100 stake — settled automatically, P/L tracked all tournament. Not financial advice.',
  learn: 'The model’s honest scoreboard: live results by category, calibration, the Germany case study, and the rules the post-mortem forced on it.',
  afl: 'Five weekly AFL calls: Elo ratings from real results vs live bookmaker prices — positive edge only, World Cup v2 rules from day one. Not financial advice.',
  nrl: 'Five weekly NRL calls: Elo ratings from real results vs live bookmaker prices — positive edge only, World Cup v2 rules from day one. Not financial advice.',
  nfl: 'The NFL model — same Elo + market-edge engine, weekly books. No bets until the season kicks off.',
  epl: 'The EPL model — same Elo + market-edge engine, weekly books. No bets until the season kicks off.',
  pot: 'Prize money allocation — work in progress.',
  bracket: 'The projected knockout bracket. Pick a round from the dropdown — predictions use betting odds, then real results as games are played.',
  fixtures: 'Every match with date, venue and score. Scores update automatically three times a day.',
  about: 'Every data source feeding this site, how often it refreshes, and the refresh history.',
};
let curTab = 'today';
let curGroup = 'pool';
function visibleSet() {
  return new Set(data.config.visibleTabs || TAB_GROUPS.flatMap((g) => g.tabs.map((t) => t[0])));
}
function renderTabRow() {
  const visible = visibleSet();
  const g = TAB_GROUPS.find((x) => x.key === curGroup) || TAB_GROUPS[0];
  el('tabs').innerHTML = g.tabs.filter((t) => visible.has(t[0]))
    .map((t) => '<button class="tabbtn" data-t="' + t[0] + '">' + t[1] + '</button>').join('');
  document.querySelectorAll('.tabbtn').forEach((b) => {
    b.classList.toggle('active', b.dataset.t === curTab);
    b.addEventListener('click', () => tab(b.dataset.t));
  });
  document.querySelectorAll('.gbtn').forEach((b) => b.classList.toggle('active', b.dataset.g === curGroup));
}
function tab(name) {
  const g = TAB_GROUPS.find((x) => x.tabs.some((t) => t[0] === name));
  curTab = name;
  if (g) curGroup = g.key;
  renderTabRow();
  document.querySelectorAll('.tabsec').forEach((s) => { s.style.display = s.id === 'sec-' + name ? 'block' : 'none'; });
  el('tabhelp').innerHTML = TABINFO[name] || '';
}
function buildTabs() {
  const visible = visibleSet();
  el('tabgroups').innerHTML = TAB_GROUPS.filter((g) => g.tabs.some((t) => visible.has(t[0])))
    .map((g) => '<button class="gbtn" data-g="' + g.key + '">' + g.label + '</button>').join('');
  document.querySelectorAll('.gbtn').forEach((b) => b.addEventListener('click', () => {
    const g = TAB_GROUPS.find((x) => x.key === b.dataset.g);
    const visibleNow = visibleSet();
    const first = g.tabs.find((t) => visibleNow.has(t[0]));
    if (first) tab(first[0]);
  }));
  renderTabRow();
}

/* ---------- Today ---------- */
function renderToday() {
  const now = new Date(), box = el('today');
  const dk = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: AEST });
  const tk = dk(now);
  let todays = ctx.fixtures.filter((m) => dk(m.d) === tk), label = 'Today’s matches (AEST)';
  if (!todays.length) {
    const fut = ctx.fixtures.filter((m) => new Date(m.d) >= now).sort((a, b) => new Date(a.d) - new Date(b.d));
    if (fut.length) {
      const nk = dk(fut[0].d);
      todays = ctx.fixtures.filter((m) => dk(m.d) === nk);
      label = 'Next matchday (AEST) · ' + new Date(fut[0].d).toLocaleDateString('en-AU', { timeZone: AEST, weekday: 'long', day: 'numeric', month: 'long' });
    }
  }
  todays.sort((a, b) => new Date(a.d) - new Date(b.d));
  if (!todays.length) { box.innerHTML = '<p class="muted">Tournament finished — see the Bracket Prediction tab for the winner!</p>'; return; }
  let sim = null, h = '<h3 style="margin-top:0">' + esc(label) + '</h3><div class="cards">';
  todays.forEach((m) => {
    let home = m.h, away = m.a;
    if (m.r >= 4) { if (!sim) sim = predictBracket(ctx.teams, ctx.fixtures, ctx.scores); const rr = sim.resolveMatch(m.no); home = rr.home; away = rr.away; }
    const s = ctx.scores[m.no], sc = (s && s.h !== '' && s.a !== '' && s.h != null && s.a != null) ? s.h + ' – ' + s.a : '';
    // Knockout tie level after extra time + decided on penalties: the feed
    // names the winner in s.w. Show who went through, since the scoreline alone
    // ('1 – 1') doesn't say.
    const pensWinner = (m.r >= 4 && s && Number(s.h) === Number(s.a) && s.w) ? s.w : null;
    const oh = ownerOf(home), oa = ownerOf(away);
    const t = new Date(m.d).toLocaleTimeString('en-AU', { timeZone: AEST, hour: '2-digit', minute: '2-digit' }) + ' AEST';
    h += '<div class="card"><div class="card-h"><b>' + t + '</b><span class="pill">' + esc(m.rn) + (m.g ? ' ' + m.g : '') + '</span></div>'
      + '<div class="todaymatch"><div class="tm"><div><b>' + esc(home) + '</b></div>' + (oh ? '<span class="ownerbadge">' + esc(oh) + '</span>' : '<span class="muted">—</span>') + '</div>'
      + '<div class="vs">' + (sc || 'v') + (pensWinner ? '<div class="muted" style="font-size:11px;font-weight:600">pens</div>' : '') + '</div>'
      + '<div class="tm"><div><b>' + esc(away) + '</b></div>' + (oa ? '<span class="ownerbadge">' + esc(oa) + '</span>' : '<span class="muted">—</span>') + '</div></div>'
      + (pensWinner ? '<div class="good" style="margin-top:6px;text-align:center;font-size:12.5px">🥅 ' + esc(pensWinner) + ' won on penalties</div>' : '')
      + '<div class="muted" style="margin-top:6px">' + esc(m.v) + '</div></div>';
  });
  box.innerHTML = h + '</div>';
}

/* ---------- Pool ---------- */
function renderLeaderboard() {
  const st = computeStandings(ctx.teams, ctx.fixtures, ctx.scores);
  const rows = poolRows(ctx);
  let h = '<table><thead><tr><th>#</th><th>Player</th><th>Teams</th><th>Grp pts</th><th>Bonus</th><th>Total</th><th>GD</th><th>Advancing</th></tr></thead><tbody>';
  rows.forEach((r, i) => {
    const cls = i === 0 && rows.length > 1 ? 'qual' : (i === rows.length - 1 && rows.length > 1 ? 'bub' : '');
    h += '<tr class="' + cls + '"><td class="c">' + (i === 0 ? '🥇' : (i === rows.length - 1 && rows.length > 1 ? '🥄' : i + 1)) + '</td><td><b>' + esc(r.p) + '</b></td><td class="c">' + r.n + '</td><td class="c">' + r.gp + '</td><td class="c">' + (r.bonus || '') + '</td><td class="c"><b>' + r.total + '</b></td><td class="c">' + r.gd + '</td><td class="c">' + r.adv + '</td></tr>';
  });
  el('lb').innerHTML = h + '</tbody></table><p class="muted" style="margin-top:4px">Scoring: 3 pts a win, 1 a draw (group stage) + knockout bonus (win R32 +4, R16 +6, QF +8, SF +10, 3rd +5, Final +12). 🥇 leader · 🥄 wooden spoon.</p>';
  const groups = {};
  Object.keys(st).forEach((k) => { const x = st[k]; (groups[x.g] = groups[x.g] || []).push(x); });
  let out = '<div class="groupgrid">';
  Object.keys(groups).sort().forEach((g) => {
    const arr = groups[g].sort((a, b) => a.rank - b.rank);
    out += '<div class="gtable"><h4>Group ' + g + '</h4><table><thead><tr><th>#</th><th>Team</th><th>Owner</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GD</th><th>Pts</th><th>Odds</th></tr></thead><tbody>';
    arr.forEach((x) => {
      const cls = x.rank <= 2 ? 'qual' : (x.rank === 3 ? 'bub' : 'out');
      out += '<tr class="' + cls + '"><td class="c">' + x.rank + '</td><td><b>' + esc(x.n) + '</b></td><td class="muted">' + esc(ownerOf(x.n)) + '</td><td class="c">' + x.p + '</td><td class="c">' + x.w + '</td><td class="c">' + x.d + '</td><td class="c">' + x.l + '</td><td class="c">' + x.gd + '</td><td class="c"><b>' + x.pts + '</b></td><td class="c muted">' + amer(x.o) + '</td></tr>';
    });
    out += '</tbody></table></div>';
  });
  out += '</div><p class="muted" style="margin-top:6px">Green = projected to advance (top 2) · amber = 3rd-place bubble. Before games start, positions are seeded by betting odds.</p>';
  el('teamStatus').innerHTML = out;
}

/* ---------- My Team ---------- */
let selPlayer = null;
function renderMyTeam() {
  const sel = el('playerSel'), prev = selPlayer || sel.value;
  sel.innerHTML = ctx.players.map((p) => '<option>' + esc(p) + '</option>').join('');
  if (ctx.players.indexOf(prev) >= 0) sel.value = prev;
  selPlayer = sel.value;
  const st = computeStandings(ctx.teams, ctx.fixtures, ctx.scores), p = selPlayer, box = el('myteam');
  if (!p) { box.innerHTML = '<p class="muted">No players configured.</p>'; el('allteams').innerHTML = ''; return; }
  const ts = teamsOf(ctx, p);
  let pts = 0, gf = 0, ga = 0, alive = 0;
  const rows = ts.map((t) => { const x = st[t]; pts += x.pts; gf += x.gf; ga += x.ga; if (x.rank <= 2) alive++; return x; }).sort((a, b) => b.pts - a.pts || b.gd - a.gd);
  let h = '<div class="mtsum"><span class="pill">' + ts.length + ' teams</span><span class="pill">' + pts + ' pts</span><span class="pill">GF ' + gf + '</span><span class="pill">GA ' + ga + '</span><span class="pill">' + alive + ' advancing</span></div>';
  h += '<table><thead><tr><th>Team</th><th>Grp</th><th>Odds</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GF</th><th>GA</th><th>GD</th><th>Pts</th><th>Pos</th><th>Projected Status</th></tr></thead><tbody>';
  rows.forEach((x) => {
    const cl = x.rank <= 2 ? 'good' : (x.rank === 3 ? 'warn' : 'bad'), lab = x.rank <= 2 ? 'Advancing' : (x.rank === 3 ? '3rd – bubble' : 'Eliminated');
    h += '<tr><td><b>' + esc(x.n) + '</b></td><td class="c">' + x.g + '</td><td class="c">' + amer(x.o) + '</td><td class="c">' + x.p + '</td><td class="c">' + x.w + '</td><td class="c">' + x.d + '</td><td class="c">' + x.l + '</td><td class="c">' + x.gf + '</td><td class="c">' + x.ga + '</td><td class="c">' + x.gd + '</td><td class="c"><b>' + x.pts + '</b></td><td class="c">' + x.g + x.rank + '</td><td class="c ' + cl + '">' + lab + '</td></tr>';
  });
  box.innerHTML = h + '</tbody></table>';
  let a = '<table><thead><tr><th>Player</th><th>Teams</th><th>Pts</th></tr></thead><tbody>';
  ctx.players.forEach((pp) => {
    const tt = teamsOf(ctx, pp), tp = tt.reduce((s, t) => s + st[t].pts, 0);
    a += '<tr><td><b>' + esc(pp) + '</b></td><td>' + tt.map(esc).join(', ') + '</td><td class="c"><b>' + tp + '</b></td></tr>';
  });
  el('allteams').innerHTML = a + '</tbody></table>';
  let m = '<table><thead><tr><th>Team</th><th>Grp</th><th>Owner</th><th>Odds</th></tr></thead><tbody>';
  ctx.teams.forEach((t) => { m += '<tr><td>' + esc(t.n) + '</td><td class="c">' + t.g + '</td><td>' + esc(ownerOf(t.n)) + '</td><td class="c">' + amer(t.o) + '</td></tr>'; });
  el('master').innerHTML = m + '</tbody></table>';
}

/* ---------- Summary ---------- */
let sumPlayer = null;
function renderSummary() {
  const sel = el('sumSel'), prev = sumPlayer || sel.value;
  sel.innerHTML = ctx.players.map((p) => '<option>' + esc(p) + '</option>').join('');
  if (ctx.players.indexOf(prev) >= 0) sel.value = prev;
  sumPlayer = sel.value;
  const box = el('summary');
  if (!sumPlayer) { box.innerHTML = '<p class="muted">No players configured.</p>'; return; }
  const p = sumPlayer, N = ctx.players.length;
  const pr = poolRows(ctx), me = pr.filter((x) => x.p === p)[0], poolRank = rankIn(pr, p);
  const wr = winRows(ctx), mw = wr.filter((x) => x.p === p)[0], winRank = rankIn(wr, p);
  const gfArr = wildRows(ctx).sort((a, b) => b.gf - a.gf), gfRank = rankIn(gfArr, p);
  const gaArr = wildRows(ctx).sort((a, b) => b.ga - a.ga), gaRank = rankIn(gaArr, p);
  const prizes = prizeTable(ctx).filter((z) => z.leader === p);
  const card = (t, big, sub) => '<div class="card"><div class="muted">' + t + '</div><div class="bignum">' + big + '</div><div class="muted">' + (sub || '') + '</div></div>';
  let h = '<div class="cards">';
  h += card('Pool position', '#' + poolRank + ' <span class="muted">of ' + N + '</span>', me.total + ' pts (' + me.gp + ' + ' + me.bonus + ' bonus)');
  h += card('Win the cup', '#' + winRank, pct(mw.prob) + ' · ' + probFrac(mw.prob));
  const sp = data.sim && data.sim.players[p];
  if (sp) h += card('Teams in the Last 8', sp.expLast8.toFixed(1) + ' <span class="muted">expected</span>', pct(sp.pAtLeastOneLast8, 0) + ' chance of at least one');
  h += card('Most Goals For', '#' + gfRank, me.gf + ' goals scored');
  h += card('Most Goals Against', '#' + gaRank, me.ga + ' conceded');
  h += card('Knockout bonus', me.bonus + ' pts', 'from teams winning KO ties');
  h += card('Teams advancing', me.adv + ' / ' + me.n, 'projected top-2 finishes');
  h += '</div>';
  h += '<div class="prizebox"><b>💰 Prizes ' + esc(p) + ' is currently winning:</b> ' + (prizes.length ? prizes.map((z) => z.label).join(' &nbsp;·&nbsp; ') : '<span class="muted">none right now</span>') + ' <span class="muted">(amounts TBC)</span></div>';
  const st = computeStandings(ctx.teams, ctx.fixtures, ctx.scores);
  const ts = teamsOf(ctx, p).map((t) => st[t]).sort((a, b) => b.pts - a.pts);
  h += '<h3>' + esc(p) + '’s teams</h3><table><thead><tr><th>Team</th><th>Grp</th><th>Odds</th><th>Pts</th><th>GD</th><th>Pos</th><th>Projected Status</th></tr></thead><tbody>';
  ts.forEach((x) => {
    const cl = x.rank <= 2 ? 'good' : (x.rank === 3 ? 'warn' : 'bad'), lab = x.rank <= 2 ? 'Advancing' : (x.rank === 3 ? '3rd – bubble' : 'Eliminated');
    h += '<tr><td><b>' + esc(x.n) + '</b></td><td class="c">' + x.g + '</td><td class="c">' + amer(x.o) + '</td><td class="c"><b>' + x.pts + '</b></td><td class="c">' + x.gd + '</td><td class="c">' + x.g + x.rank + '</td><td class="c ' + cl + '">' + lab + '</td></tr>';
  });
  box.innerHTML = h + '</tbody></table>';
}

/* ---------- Goal Differential Bet ---------- */
function renderWildCard() {
  const rows = wildRows(ctx).map((x) => ({ ...x, net: x.gf - x.ga }))
    .sort((a, b) => b.net - a.net || b.gf - a.gf || a.p.localeCompare(b.p));
  const bestGf = Math.max(...rows.map((x) => x.gf));
  const worstGa = Math.max(...rows.map((x) => x.ga));
  let h = '<table><thead><tr><th>#</th><th>Player</th><th>Goals For</th><th>Goals Against</th><th>Net Score</th></tr></thead><tbody>';
  rows.forEach((x, i) => {
    const lead = i === 0 && x.net > 0;
    const netCls = x.net > 0 ? 'good' : x.net < 0 ? 'bad' : 'muted';
    h += '<tr' + (lead ? ' class="qual"' : '') + '><td class="c">' + (lead ? '🏆' : i + 1) + '</td><td><b>' + esc(x.p) + '</b></td>'
      + '<td class="c">' + x.gf + (x.gf === bestGf && bestGf > 0 ? ' ⚽' : '') + '</td>'
      + '<td class="c">' + x.ga + (x.ga === worstGa && worstGa > 0 ? ' 🥅' : '') + '</td>'
      + '<td class="c ' + netCls + '"><b>' + (x.net > 0 ? '+' : '') + x.net + '</b></td></tr>';
  });
  el('gdTable').innerHTML = h + '</tbody></table>';
}

/* ---------- Win Odds ---------- */
function renderWinOdds() {
  const rows = winRows(ctx);
  let h = '<table><thead><tr><th>#</th><th>Player</th><th>Win chance</th><th>Fair odds</th><th>Best team</th><th>Teams</th></tr></thead><tbody>';
  rows.forEach((x, i) => {
    const lead = i === 0 && x.prob > 0;
    h += '<tr' + (lead ? ' class="qual"' : '') + '><td class="c">' + (lead ? '👑' : i + 1) + '</td><td><b>' + esc(x.p) + '</b></td>'
      + '<td class="c"><b>' + pct(x.prob) + '</b></td><td class="c">' + probFrac(x.prob) + '</td>'
      + '<td>' + (x.best ? '<b>' + esc(x.best) + '</b> <span class="muted">' + amer(odds(x.best)) + '</span>' : '') + '</td><td class="c">' + x.n + '</td></tr>';
  });
  el('winOdds').innerHTML = h + '</tbody></table>';
}

/* ---------- Projections (Monte-Carlo, precomputed in data.json) ---------- */
function renderProjections() {
  const sim = data.sim;
  if (!sim) { el('projPlayers').innerHTML = '<p class="muted">No simulation in the data yet.</p>'; return; }
  el('projMeta').textContent = 'Based on ' + sim.iterations.toLocaleString() + ' tournament simulations, refreshed with every data update.';
  const bar = (p) => '<div class="bar"><i style="width:' + Math.round(p * 100) + '%"></i></div>';
  const pRows = ctx.players.map((p) => ({ p, ...sim.players[p] })).sort((a, b) => (b.pTopPool ?? 0) - (a.pTopPool ?? 0) || b.expLast8 - a.expLast8);
  let h = '<table><thead><tr><th>#</th><th>Player</th><th>🏆 Wins the pool</th><th></th><th>Expected teams in Last 8</th><th>≥ 1 in Last 8</th><th>Owns the champion</th><th>🥄 Spoon risk</th></tr></thead><tbody>';
  pRows.forEach((x, i) => {
    h += '<tr' + (i === 0 ? ' class="qual"' : '') + '><td class="c">' + (i === 0 ? '🔮' : i + 1) + '</td><td><b>' + esc(x.p) + '</b></td>'
      + '<td class="c"><b>' + (x.pTopPool != null ? pct(x.pTopPool) : '—') + '</b></td><td>' + bar(x.pTopPool ?? 0) + '</td>'
      + '<td class="c">' + x.expLast8.toFixed(2) + '</td>'
      + '<td class="c">' + pct(x.pAtLeastOneLast8, 0) + '</td><td class="c">' + pct(x.pChampion) + '</td>'
      + '<td class="c">' + (x.pSpoon != null ? pct(x.pSpoon) : '—') + '</td></tr>';
  });
  el('projPlayers').innerHTML = h + '</tbody></table>';
  const tRows = Object.keys(sim.teams).map((n) => ({ n, ...sim.teams[n] })).sort((a, b) => b.champion - a.champion || b.last8 - a.last8);
  let t = '<table><thead><tr><th>Team</th><th>Owner</th><th>Last 32</th><th>Last 16</th><th>Last 8</th><th></th><th>Last 4</th><th>Final</th><th>🏆 Win</th></tr></thead><tbody>';
  tRows.forEach((x) => {
    t += '<tr><td><b>' + esc(x.n) + '</b></td><td class="muted">' + esc(x.owner) + '</td>'
      + '<td class="c">' + pct(x.last32, 0) + '</td><td class="c">' + pct(x.last16, 0) + '</td>'
      + '<td class="c"><b>' + pct(x.last8, 0) + '</b></td><td>' + bar(x.last8) + '</td>'
      + '<td class="c">' + pct(x.last4, 0) + '</td><td class="c">' + pct(x.final, 0) + '</td><td class="c"><b>' + pct(x.champion) + '</b></td></tr>';
  });
  el('projTeams').innerHTML = t + '</tbody></table>';
}

/* ---------- Golden Boot Pot ---------- */
function renderGoldenBoot() {
  const gb = data.sidePots?.goldenBoot;
  if (!gb) return;
  el('gbMeta').textContent = gb.live ? 'Goals update automatically with each refresh.' : 'Goals are updated by the admin after each matchday.';
  el('gbPot').innerHTML = 'Entry: <b>' + aud(gb.entryFeeAUD) + '</b> each &nbsp;·&nbsp; Pot: <b>' + aud(gb.pot) + '</b>';
  if (!gb.rows.length) {
    el('goldenBoot').innerHTML = '<p class="muted">The striker draw hasn’t been run yet.</p>';
    return;
  }
  let h = '<table><thead><tr><th>#</th><th>Player</th><th>Their strikers</th><th>Total goals</th></tr></thead><tbody>';
  gb.rows.forEach((r, i) => {
    const lead = i === 0 && r.total > 0;
    const strikers = (r.strikers || []).map((s) =>
      '<span class="t"><b>' + esc(s.name) + '</b> <em>' + esc(s.team) + '</em>' + (s.goals ? ' ⚽' + s.goals : '') + '</span>').join(' ');
    h += '<tr' + (lead ? ' class="qual"' : '') + '><td class="c">' + (lead ? '👟' : i + 1) + '</td><td><b>' + esc(r.participant) + '</b></td>'
      + '<td><div class="teamlist">' + strikers + '</div></td><td class="c"><b>' + r.total + '</b></td></tr>';
  });
  el('goldenBoot').innerHTML = h + '</tbody></table>';
}

/* ---------- Dark Horse Prize ---------- */
function renderDarkHorse() {
  const dh = data.sidePots?.darkHorse;
  if (!dh) { el('darkHorse').innerHTML = '<p class="muted">Waiting for FIFA rankings config.</p>'; return; }
  el('dhExplain').innerHTML = 'All 48 teams, worst FIFA ranking first. The prize goes to the owner of the <b>eligible</b> team (the ' + dh.candidateCount
    + ' lowest-ranked qualifiers) that progresses furthest' + (dh.prizeAUD ? ' — <b>' + aud(dh.prizeAUD) + '</b>' : '')
    + '. Ties go to the worse-ranked team. Rankings: ' + esc(dh.rankingsAsOf) + '.';
  let h = '';
  if (dh.leader) h += '<div class="champbox">🐴 ' + (dh.decided ? 'Dark Horse winner' : 'Current dark horse') + ': <b>' + esc(dh.leader.team) + '</b> (FIFA #' + dh.leader.rank + ') — ' + esc(dh.leader.owner) + ' <span class="pill">' + esc(dh.leader.stageLabel) + '</span></div>';
  h += '<table><thead><tr><th>Team</th><th>FIFA rank</th><th>Owner</th><th>Eligible</th><th>Reached</th><th>Status</th><th>Wins it (sim)</th></tr></thead><tbody>';
  dh.rows.forEach((r) => {
    const p = data.sim.darkHorseTeams ? data.sim.darkHorseTeams[r.team] : null;
    const eligible = r.eligible !== false;
    h += '<tr' + (dh.leader && r.team === dh.leader.team ? ' class="qual"' : '') + '><td><b>' + esc(r.team) + '</b></td><td class="c">' + r.rank + '</td><td class="muted">' + esc(r.owner) + '</td>'
      + '<td class="c">' + (eligible ? '✅' : '<span class="muted">—</span>') + '</td>'
      + '<td class="c">' + esc(r.stageLabel) + '</td><td class="c ' + (r.alive ? 'good' : 'bad') + '">' + (r.alive ? 'Alive' : 'Out') + '</td>'
      + '<td class="c">' + (eligible && p != null ? pct(p) : '—') + '</td></tr>';
  });
  el('darkHorse').innerHTML = h + '</tbody></table>';
}

/* ---------- Chaos Pot (Curnow Bets) ---------- */
function renderChaos() {
  const ch = data.sidePots?.chaos;
  if (!ch) return;
  const cp = ch.points || CHAOS_DEFAULT_POINTS;
  el('chaosExplain').innerHTML = 'Own goal <b>+' + cp.ownGoal + '</b> · Red card <b>+' + cp.redCard + '</b> · Penalty miss <b>+' + cp.penaltyMiss + '</b> · Goalkeeper goal <b>+' + cp.gkGoal + '</b>. The team with the most chaos points wins' + (ch.prizeAUD ? ' <b>' + aud(ch.prizeAUD) + '</b>' : '') + ' for its owner. Events are detected automatically and can be corrected by the admin.';
  if (!ch.rows.length) {
    el('chaos').innerHTML = '<p class="muted">No chaos yet — own goals, red cards, missed pens and keeper goals will show up here as they happen. 🍿</p>';
  } else {
    let h = '<table><thead><tr><th>#</th><th>Team</th><th>Owner</th><th>Own goals</th><th>Red cards</th><th>Pens missed</th><th>GK goals</th><th>Chaos pts</th></tr></thead><tbody>';
    ch.rows.forEach((r, i) => {
      const lead = i === 0 && r.points > 0;
      h += '<tr' + (lead ? ' class="qual"' : '') + '><td class="c">' + (lead ? '🤡' : i + 1) + '</td><td><b>' + esc(r.team) + '</b></td><td class="muted">' + esc(r.owner) + '</td><td class="c">' + r.ownGoal + '</td><td class="c">' + r.redCard + '</td><td class="c">' + r.penaltyMiss + '</td><td class="c">' + r.gkGoal + '</td><td class="c"><b>' + r.points + '</b></td></tr>';
    });
    el('chaos').innerHTML = h + '</tbody></table>';
  }
}

/* ---------- Pot & Prizes ---------- */
function renderPot() {
  el('potTable').innerHTML = '<div class="note" style="font-size:15px;padding:18px 20px">🚧 <b>Work in progress</b> — waiting for Nathaniel to allocate funds to each of the games.</div>';
}

/* ---------- Fixtures ---------- */
function renderFixtures() {
  let h = '<table><thead><tr><th>#</th><th>Round</th><th>Date / Kick-off (UTC)</th><th>Your local time</th><th>Venue</th><th>Match</th><th>Score</th></tr></thead><tbody>';
  let sim = null;
  ctx.fixtures.forEach((m) => {
    const f = fmtDate(m.d);
    const s = ctx.scores[m.no];
    const sc = (s && s.h !== '' && s.a !== '' && s.h != null && s.a != null) ? '<b>' + s.h + ' – ' + s.a + '</b>' : '<span class="muted">–</span>';
    // Resolve knockout rows through the bracket so a half-known later round
    // shows the predicted opponent, never a real team next to a "W75" code.
    let home = m.h, away = m.a;
    if (m.r >= 4) { if (!sim) sim = predictBracket(ctx.teams, ctx.fixtures, ctx.scores); const r = sim.resolveMatch(m.no); home = r.home; away = r.away; }
    h += '<tr><td class="c">' + m.no + '</td><td>' + m.rn + (m.g ? ' ' + m.g : '') + '</td><td>' + f.utc + '</td><td class="muted">' + f.loc + '</td><td class="muted">' + esc(m.v) + '</td>'
      + '<td><b>' + esc(home) + '</b> v <b>' + esc(away) + '</b></td><td class="c">' + sc + '</td></tr>';
  });
  el('fixtures').innerHTML = h + '</tbody></table>';
}

/* ---------- Bracket ---------- */
let selRound = 'r32';
function renderBracket() {
  const sim = predictBracket(ctx.teams, ctx.fixtures, ctx.scores);
  const roundOf = { r32: 4, r16: 5, qf: 6, sf: 7, final: 9 };
  const matches = ctx.fixtures.filter((m) => m.r === roundOf[selRound]).sort((a, b) => a.no - b.no);
  const fin = sim.resolveMatch(104);
  const champOwner = ownerOf(fin.winner);
  el('champ').innerHTML = '<div class="champbox">🏆 Predicted champion: <b>' + esc(fin.winner) + '</b>' + (champOwner ? ' &mdash; ' + esc(champOwner) : '') + (fin.played ? ' <span class="pill">confirmed</span>' : ' <span class="pill">projected</span>') + '</div>';
  // Describe a fixture slot as either a CONFIRMED real team or a
  // "Winner of A v B" placeholder (recursing into the feeder tie), so the
  // bracket shows the actual games rather than a guessed opponent.
  const gmap = teamByGroupRank(sim.standings);
  const fx = (no) => ctx.fixtures.find((x) => x.no === no);
  // Compact "candidates" for a not-yet-played feeder: a real team once known,
  // else the underlying teams joined by "/" ("one of these"), so a slot two
  // rounds out reads "Winner of Portugal/Croatia v Spain/Austria" rather than
  // a doubly-nested "Winner of Winner of …".
  function candidates(code) {
    if (/^W\d+$/.test(code)) {
      const f = +code.slice(1), r = sim.resolveMatch(f);
      if (r.played) return r.winner;
      const fm = fx(f); return candidates(fm.h) + '/' + candidates(fm.a);
    }
    if (/^L\d+$/.test(code)) {
      const f = +code.slice(1), r = sim.resolveMatch(f);
      if (r.played) return r.loser;
      const fm = fx(f); return candidates(fm.h) + '/' + candidates(fm.a);
    }
    return resolveSlot(code, gmap);
  }
  // Describe a displayed slot as a CONFIRMED real team or a one-level
  // "Winner of A v B" placeholder.
  function describe(code) {
    if (/^(W|L)\d+$/.test(code)) {
      const win = code[0] === 'W', f = +code.slice(1), r = sim.resolveMatch(f);
      if (r.played) return { label: win ? r.winner : r.loser, confirmed: true };
      const fm = fx(f);
      return { label: (win ? 'Winner of ' : 'Loser of ') + candidates(fm.h) + ' v ' + candidates(fm.a), confirmed: false };
    }
    const resolved = resolveSlot(code, gmap); // 1A/2B -> group team; 3XXXX -> 'Best 3rd (…)'; real name -> itself
    const confirmed = !/^Best 3rd/.test(resolved) && !/^[12][A-L]$/.test(resolved) && !/^3[A-L]+$/.test(resolved);
    return { label: resolved, confirmed };
  }
  const sideCell = (d) => (d.confirmed
    ? '<td><b>' + esc(d.label) + '</b></td><td class="muted">' + esc(ownerOf(d.label)) + '</td>'
    : '<td class="muted" colspan="2">' + esc(d.label) + '</td>');
  let h = '<table><thead><tr><th>#</th><th>Date (UTC)</th><th>Venue</th><th>Home</th><th>Owner</th><th>Away</th><th>Owner</th><th>Predicted winner</th></tr></thead><tbody>';
  matches.forEach((m) => {
    const r = sim.resolveMatch(m.no);
    const dh = describe(m.h, m.no), da = describe(m.a, m.no);
    h += '<tr><td class="c">' + m.no + (r.played ? ' ✅' : '') + '</td><td>' + fmtDate(m.d).utc + '</td><td class="muted">' + esc(m.v) + '</td>'
      + sideCell(dh) + sideCell(da)
      + '<td class="c good"><b>' + esc(r.winner) + '</b>' + (ownerOf(r.winner) ? ' <span class="muted">(' + esc(ownerOf(r.winner)) + ')</span>' : '') + '</td></tr>';
  });
  el('bracket').innerHTML = h + '</tbody></table>';
  el('bracketLegend').innerHTML = '<b>How this works</b><br>'
    + '• <b>The games:</b> once a tie’s feeder matches are decided, the real teams show. Until then a slot reads <b>“Winner of A v B”</b> so you see the actual fixture, not a guessed opponent. Bracket wiring follows the official FIFA schedule.<br>'
    + '• <b>Predicted winner:</b> each tie is still projected — by real results once played, otherwise the team with the shorter betting odds. <b>✅</b> marks a tie that has actually been played.<br>'
    + '• <b>Third-place teams</b> show the groups they may come from until they are confirmed.';
}

/* ---------- Model vs Market ---------- */
function renderModelMarket() {
  const mm = data.modelMarket;
  if (!mm) return;
  const edgeCell = (e) => '<b class="' + (e >= 0.03 ? 'good' : e <= -0.03 ? 'bad' : 'muted') + '">' + (e >= 0 ? '+' : '') + (e * 100).toFixed(1) + '%</b>';
  if (!mm.matches.length) {
    el('mvmMatches').innerHTML = '<p class="muted">No upcoming priced matches right now — prices land with each refresh once the books open the next round.</p>';
  } else {
    el('mvmMeta').textContent = mm.matches.length + ' upcoming matches priced by the books. Sorted by kickoff; the bookmaker margin (overround) is stripped from the Implied column.';
    let h = '<table><thead><tr><th>Match</th><th>Kickoff (AEST)</th><th>Pick</th><th>Model</th><th>Books</th><th>Implied</th><th>Edge</th></tr></thead><tbody>';
    mm.matches.forEach((m) => {
      const t = new Date(m.d).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane', weekday: 'short', hour: '2-digit', minute: '2-digit' });
      m.outcomes.forEach((o, i) => {
        h += '<tr' + (o.edge >= 0.05 ? ' class="qual"' : '') + '>'
          + (i === 0 ? '<td rowspan="' + m.outcomes.length + '"><b>' + esc(m.match) + '</b><div class="muted" style="font-size:11px">' + esc(m.rn + (m.g ? ' ' + m.g : '')) + '</div></td><td rowspan="' + m.outcomes.length + '" class="muted">' + esc(t) + '</td>' : '')
          + '<td>' + esc(o.pick) + '</td><td class="c"><b>' + pct(o.model) + '</b></td><td class="c">' + o.odds.toFixed(2) + '</td>'
          + '<td class="c muted">' + pct(o.implied) + '</td><td class="c">' + edgeCell(o.edge) + '</td></tr>';
      });
    });
    el('mvmMatches').innerHTML = h + '</tbody></table>';
  }
  let o = '<table><thead><tr><th>Team</th><th>Owner</th><th>Books</th><th>Market implied</th><th>Model (sim)</th><th>Edge</th></tr></thead><tbody>';
  mm.outrights.forEach((x) => {
    o += '<tr' + (x.edge >= 0.15 ? ' class="qual"' : '') + '><td><b>' + esc(x.team) + '</b></td><td class="muted">' + esc(ctx.owners[x.team] || '') + '</td>'
      + '<td class="c">' + x.odds.toFixed(0) + '</td><td class="c muted">' + pct(x.implied) + '</td><td class="c"><b>' + pct(x.model) + '</b></td><td class="c">' + edgeCell(x.edge) + '</td></tr>';
  });
  el('mvmOutrights').innerHTML = o + '</tbody></table>';
}

/* ---------- High Risk Curnow Bets ---------- */
const BET_TYPE = { single: 'Single', multi: 'Multi', scorer: 'Goal scorer', double: 'Double chance', combo: 'Same-game combo', wildcard: 'Wildcard' };
const BET_BADGE = { pending: '⏳ Pending', won: '✅ Landed', lost: '❌ Busted' };
function betPnl(b) {
  const stake = b.stake ?? 100;
  const odds = b.payoutOdds ?? b.marketOdds ?? b.fairOdds;
  if (b.status === 'won') return Math.round(stake * (odds - 1) * 100) / 100;
  if (b.status === 'lost') return -stake;
  return 0;
}
function pnlCell(b) {
  if (b.status === 'pending') return '<span class="muted">' + aud(b.stake ?? 100) + ' live</span>';
  const v = betPnl(b);
  return '<b class="' + (v >= 0 ? 'good' : 'bad') + '">' + (v >= 0 ? '+' : '−') + aud(Math.abs(v)) + '</b>';
}
function betClv(b) {
  const locked = b.payoutOdds ?? b.marketOdds ?? b.fairOdds;
  return b.closingOdds ? locked / b.closingOdds - 1 : null;
}
function clvCell(b) {
  const v = betClv(b);
  if (v == null) return '<span class="muted">—</span>';
  return '<b class="' + (v >= 0 ? 'good' : 'bad') + '">' + (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%</b>';
}
function betTable(bets, withComments) {
  let h = '<table><thead><tr><th>#</th><th>The call</th><th>Type</th><th>Selection</th><th>Model</th><th>Fair odds</th><th>Books</th><th>Pays</th><th>CLV</th><th>$100 P/L</th><th>Status</th></tr></thead><tbody>';
  bets.forEach((b, i) => {
    const cls = b.status === 'won' ? 'qual' : b.status === 'lost' ? 'bub' : '';
    h += '<tr class="' + cls + '"><td class="c">' + (i + 1) + '</td><td><b>' + esc(b.name) + '</b></td><td class="c">' + (BET_TYPE[b.type] || b.type) + '</td>'
      + '<td>' + esc(b.selection) + '</td><td class="c"><b>' + pct(b.prob, 0) + '</b></td><td class="c">' + b.fairOdds.toFixed(2) + '</td>'
      + '<td class="c">' + (b.marketOdds ? b.marketOdds.toFixed(2) + (b.edge != null ? ' <span class="' + (b.edge >= 0.03 ? 'good' : 'muted') + '">(' + (b.edge >= 0 ? '+' : '') + (b.edge * 100).toFixed(0) + '%)</span>' : '') : '<span class="muted">—</span>') + '</td>'
      + '<td class="c">' + (b.payoutOdds ?? b.fairOdds).toFixed(2) + '</td>'
      + '<td class="c">' + clvCell(b) + '</td>'
      + '<td class="c">' + pnlCell(b) + '</td>'
      + '<td class="c">' + (BET_BADGE[b.status] || b.status) + '</td></tr>';
    if (withComments) h += '<tr><td></td><td colspan="10" class="muted" style="font-size:12.5px;padding-top:0">' + esc(b.comment) + '</td></tr>';
  });
  return h + '</tbody></table>';
}
let betGroup = 'today';
const BET_GROUP_LABEL = {
  today: '⚡ Best bets that finalise today',
  longer: '🗓️ Longer bets — settle over the tournament',
};
function renderHighRiskBets() {
  const bk = data.bets;
  if (!bk || !bk.current) { el('betsToday').innerHTML = '<p class="muted">First book of calls arrives with the next refresh.</p>'; return; }
  const all = [...(bk.history || []).flatMap((d) => d.bets), ...bk.current.bets];
  const won = all.filter((b) => b.status === 'won').length;
  const lost = all.filter((b) => b.status === 'lost').length;
  el('betsRecord').innerHTML = 'Record so far: <b class="good">' + won + ' landed</b> · <b class="bad">' + lost + ' busted</b> · '
    + (all.length - won - lost) + ' pending' + (won + lost > 0 ? ' &nbsp;·&nbsp; hit rate <b>' + Math.round((won / (won + lost)) * 100) + '%</b>' : '');
  // $100-a-call simulation across the whole tournament
  const settled = all.filter((b) => b.status !== 'pending');
  const pnl = settled.reduce((s, b) => s + betPnl(b), 0);
  const staked = settled.reduce((s, b) => s + (b.stake ?? 100), 0);
  const live = all.length - settled.length;
  el('betsSim').innerHTML = '<b>💵 The $100 Simulation</b> — we "stake" ' + aud(100) + ' on every call at the locked price (books when we have them, fair odds otherwise). '
    + (settled.length
      ? 'Settled so far: <b>' + settled.length + '</b> calls · staked <b>' + aud(staked) + '</b> · returned <b>' + aud(staked + pnl) + '</b> · net <b class="' + (pnl >= 0 ? 'good' : 'bad') + '">' + (pnl >= 0 ? '+' : '−') + aud(Math.abs(pnl)) + '</b> (' + (staked ? ((pnl / staked) * 100).toFixed(1) : '0.0') + '% ROI)'
      : 'Nothing settled yet')
    + (live ? ' &nbsp;·&nbsp; <b>' + aud(live * 100) + '</b> riding on ' + live + ' open calls.' : '.');
  // CLV — the professionals' metric: did our locked prices beat the close?
  const clvs = all.map(betClv).filter((v) => v != null);
  if (clvs.length) {
    const avg = clvs.reduce((s, v) => s + v, 0) / clvs.length;
    el('betsSim').innerHTML += '<br><b>📏 Closing line value:</b> across ' + clvs.length + ' priced call' + (clvs.length === 1 ? '' : 's')
      + ' our locked prices average <b class="' + (avg >= 0 ? 'good' : 'bad') + '">' + (avg >= 0 ? '+' : '') + (avg * 100).toFixed(1) + '%</b> against the closing line — '
      + (avg >= 0 ? 'beating the close is what long-term winning looks like.' : 'below the close means the market moved against our calls after we made them.');
  }
  const sel = el('betGroupSel');
  if (sel && sel.value !== betGroup) sel.value = betGroup;
  const groupOf = (b) => b.group || (b.type === 'wildcard' ? 'longer' : 'today');
  const shown = bk.current.bets.filter((b) => groupOf(b) === betGroup);
  el('betsToday').innerHTML = '<h3 style="margin-top:6px">' + BET_GROUP_LABEL[betGroup] + ' · ' + esc(bk.current.date) + ' (AEST)</h3>'
    + (shown.length ? betTable(shown, true)
      : '<p class="muted">' + (betGroup === 'today' ? 'No qualifying matches finalise today — the model won’t call a coin flip.' : 'No longer-range angles today.') + '</p>');
  const hist = (bk.history || []).slice().reverse();
  el('betsHistory').innerHTML = hist.length
    ? hist.map((d) => {
      const w = d.bets.filter((b) => b.status === 'won').length, l = d.bets.filter((b) => b.status === 'lost').length;
      const dayPnl = d.bets.reduce((s, b) => s + betPnl(b), 0);
      return '<h4 style="margin:14px 0 4px;color:#1A2A4F">' + esc(d.date) + ' <span class="muted">(' + w + '–' + l + ' · '
        + (dayPnl >= 0 ? '+' : '−') + aud(Math.abs(dayPnl)) + ')</span></h4>' + betTable(d.bets, false);
    }).join('')
    : '<p class="muted">Day one — history starts tomorrow.</p>';
}

/* ---------- More Sports Bets (AFL / NRL / NFL / EPL) ---------- */
const SPORT_META = {
  afl: { label: 'AFL', round: 'Round' },
  nrl: { label: 'NRL', round: 'Round' },
  nfl: { label: 'NFL', round: 'Week' },
  epl: { label: 'EPL', round: 'Matchweek' },
};
// Mission A: label each accepted bet with WHY its edge exists, and show what
// the diagnosis screened out — so the page teaches, not just tips.
var CAUSE_META = {
  'model-signal': ['#1a7f37', 'clean signal', 'lineups as-rated, price steady, edge clear of the vig'],
  'longshot-bias': ['#8a6d00', 'longshot', 'a longshot — only backed because the edge was large enough to beat the shade'],
  steam: ['#b4690e', 'steam', 'price drifted against us since it opened — bet only because the edge held above 6%'],
  lineup: ['#b4690e', 'rep-window', 'rep call-ups may strip either squad and Elo can\'t see it — held to a doubled bar'],
};
var CAUSE_REJECT = {
  'model-signal': 'thin', 'longshot-bias': 'longshot shading', steam: 'steamed against us',
  lineup: 'rep-window lineup risk', 'stale-elo': 'ratings still green', 'vig-artifact': 'inside the vig',
  'lineup-blocked': 'our side depleted',
};
function causeTag(cause) {
  var m = CAUSE_META[cause];
  if (!m) return '';
  return ' <span title="' + esc(m[2]) + '" style="font-size:10.5px;font-weight:600;color:' + m[0]
    + ';border:1px solid ' + m[0] + '55;border-radius:4px;padding:1px 5px;margin-left:6px;white-space:nowrap">' + esc(m[1]) + '</span>';
}
function screenedOut(diag) {
  var r = diag && diag.rejectedByCause;
  if (!r) return '';
  var parts = Object.keys(r).filter(function (k) { return r[k] > 0; })
    .map(function (k) { return r[k] + '× ' + (CAUSE_REJECT[k] || k); });
  if (!parts.length) return '';
  return '<p class="muted" style="font-size:12px;margin-top:6px">🔎 Screened out this round: ' + esc(parts.join(', '))
    + ' — the model saw an edge but the diagnosis decided it was more likely the market knowing something we don\'t.</p>';
}
// Closing Line Value for a sports bet: how much longer our locked price was
// than the price the market closed at (positive = we beat the close).
function sportClv(b) {
  if (!b || !(b.closePrice > 1) || !(b.price > 1)) return null;
  return b.price / b.closePrice - 1;
}
function sportClvCell(b) {
  var v = sportClv(b);
  if (v == null) return '<span class="muted">—</span>';
  return '<b class="' + (v >= 0 ? 'good' : 'bad') + '">' + (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%</b>';
}
// The full-round board: every game, our model probability beside the market's,
// and the value calls highlighted (✅ = made the 5-bet book).
function slateTable(book, meta) {
  if (!book || !book.slate || !book.slate.length) return '';
  var h = '<h3 style="margin-top:20px">' + meta.round + ' ' + book.round + ' — every game: model vs market</h3>';
  h += '<p class="muted" style="font-size:12.5px;margin-top:-4px"><b>Model</b> = our Elo win probability for the home team; <b>Market</b> = the de-vigged bookmaker probability. '
    + 'Green rows have genuine value (a positive edge that survived the diagnosis); ✅ = one of this week\'s five calls.</p>';
  h += '<table><thead><tr><th>Game</th><th>Kickoff (AEST)</th><th>Model (home)</th><th>Market (home)</th><th>Best value</th></tr></thead><tbody>';
  book.slate.forEach(function (g) {
    var cls = g.value ? 'qual' : '';
    var mkt = g.marketProb != null ? pct(g.marketProb, 0) : '—';
    var gap = (g.marketProb != null) ? Math.round((g.homeProb - g.marketProb) * 100) : null;
    var gapTxt = gap == null ? '' : ' <span class="muted" style="font-size:11px">(' + (gap >= 0 ? '+' : '−') + Math.abs(gap) + ')</span>';
    var val = '—';
    if (g.value && g.bestEdge != null) {
      val = '<b class="good">' + esc(g.bestTeam) + ' +' + (g.bestEdge * 100).toFixed(0) + '%</b>' + causeTag(g.edgeCause)
        + (g.picked ? ' <span style="font-size:10.5px;font-weight:700;color:#1a7f37;border:1px solid #1a7f37;border-radius:4px;padding:1px 5px;margin-left:4px">✅ PICK</span>' : '');
    } else if (g.bestEdge != null && g.bestEdge > 0) {
      val = '<span class="muted">' + esc(g.bestTeam) + ' +' + (g.bestEdge * 100).toFixed(0) + '% · screened</span>';
    }
    h += '<tr class="' + cls + '"><td><b>' + esc(g.home) + '</b> v ' + esc(g.away) + '</td>'
      + '<td>' + fmtAEST(Date.parse(g.kickoff)) + '</td>'
      + '<td class="c"><b>' + pct(g.homeProb, 0) + '</b>' + gapTxt + '</td>'
      + '<td class="c">' + mkt + '</td>'
      + '<td>' + val + '</td></tr>';
  });
  h += '</tbody></table>';
  return h;
}
function renderSports() {
  Object.entries(SPORT_META).forEach(([key, meta]) => {
    const box = el('sport-' + key);
    if (!box) return;
    const s = data.sports?.[key];
    const intro = '<p class="muted">The World Cup model, rebuilt on its own post-mortem: probabilities come from an <b>Elo rating built on real results</b> (never self-priced), and a call only exists where the <b>bookmakers pay more than the model thinks it\'s worth</b>. Up to five calls per ' + meta.round.toLowerCase() + ', $100 virtual stakes, locked when published, settled automatically.</p>'
      + '<div class="note">🔞 Model-generated fun — not financial advice. If you do have a punt, gamble responsibly.</div>';
    if (!s || s.awaitingFixtures || (!s.started && !s.book)) {
      const when = s?.nextKickoff
        ? 'First game: <b>' + fmtAEST(Date.parse(s.nextKickoff)) + '</b>'
        : 'Season expected to start <b>' + esc(s?.expectedStart || 'TBC') + '</b>';
      box.innerHTML = intro + '<div class="prizebox">⏳ <b>Waiting for the season.</b> ' + when
        + '. The model is ready — ratings carry over from last season (regressed to the mean) and the first book of calls will appear in the week of the opening round. <b>No bets until real games begin.</b></div>';
      return;
    }
    // record + $100 sim across history and current book
    const all = [...(s.history || []).flatMap((h) => h.bets), ...(s.book?.bets || [])];
    const settled = all.filter((b) => b.status !== 'pending');
    const won = settled.filter((b) => b.status === 'won').length;
    const pnl = settled.reduce((sum, b) => sum + betPnl(b), 0);
    const money = (v) => '<b class="' + (v >= 0 ? 'good' : 'bad') + '">' + (v >= 0 ? '+' : '−') + aud(Math.abs(v)) + '</b>';
    const clvVals = all.map(sportClv).filter((v) => v != null);
    const avgClv = clvVals.length ? clvVals.reduce((x, y) => x + y, 0) / clvVals.length : null;
    let h = intro;
    h += '<div class="potTotal" style="margin:10px 0">Record: <b class="good">' + won + ' landed</b> · <b class="bad">' + (settled.length - won) + ' busted</b>'
      + (settled.length ? ' · hit rate <b>' + Math.round(won / settled.length * 100) + '%</b> · P/L ' + money(pnl) : '')
      + (avgClv != null ? ' · avg CLV <b class="' + (avgClv >= 0 ? 'good' : 'bad') + '">' + (avgClv >= 0 ? '+' : '') + (avgClv * 100).toFixed(1) + '%</b>' : '')
      + ' · ' + (all.length - settled.length) + ' open · Elo built from <b>' + (s.eloGames || 0) + '</b> results</div>';
    if (avgClv != null) h += '<p class="muted" style="font-size:12px;margin-top:-4px">CLV = how much longer our locked price was than the market\'s closing price. Consistently positive CLV is the real proof the model finds value — it shows up in ~50 bets, long before P/L settles down.</p>';
    if (s.book && s.book.bets.length) {
      h += '<h3>' + meta.round + ' ' + s.book.round + ' — this week\'s calls</h3>';
      h += '<table><thead><tr><th>#</th><th>The call</th><th>Kickoff (AEST)</th><th>Model</th><th>Books pay</th><th>Edge</th><th>CLV</th><th>$100 P/L</th><th>Status</th></tr></thead><tbody>';
      s.book.bets.forEach((b, i) => {
        const cls = b.status === 'won' ? 'qual' : b.status === 'lost' ? 'bub' : '';
        h += '<tr class="' + cls + '"><td class="c">' + (i + 1) + '</td><td><b>' + esc(b.selection) + '</b>' + causeTag(b.edgeCause) + '</td>'
          + '<td>' + fmtAEST(Date.parse(b.kickoff)) + '</td><td class="c"><b>' + pct(b.prob, 0) + '</b></td>'
          + '<td class="c">' + b.price.toFixed(2) + '</td><td class="c good">+' + (b.edge * 100).toFixed(0) + '%</td>'
          + '<td class="c">' + sportClvCell(b) + '</td>'
          + '<td class="c">' + pnlCell(b) + '</td><td class="c">' + (BET_BADGE[b.status] || b.status) + '</td></tr>';
        h += '<tr><td></td><td colspan="8" class="muted" style="font-size:12.5px;padding-top:0">' + esc(b.comment) + '</td></tr>';
        if (b.warning) h += '<tr><td></td><td colspan="8" style="font-size:12.5px;padding-top:0;color:#d4a017">⚠️ ' + esc(b.warning) + '</td></tr>';
      });
      h += '</tbody></table>';
      h += screenedOut(s.book.diagnostics);
    } else {
      h += '<p class="muted">No qualifying calls right now — the book for ' + meta.round.toLowerCase() + ' ' + (s.nextRoundNumber ?? '—')
        + ' locks in the week of the round, and only where a positive edge actually exists. An empty book is the rules working.</p>';
    }
    // the full-round model-vs-market board (shows whether or not there were bets)
    h += slateTable(s.book, meta);
    const hist = (s.history || []).slice().reverse();
    if (hist.length) {
      h += '<h3>📜 Past rounds</h3>';
      hist.forEach((d) => {
        const w = d.bets.filter((b) => b.status === 'won').length, l = d.bets.filter((b) => b.status === 'lost').length;
        const p = d.bets.reduce((sum, b) => sum + betPnl(b), 0);
        h += '<h4 style="margin:12px 0 4px;color:#1A2A4F">' + meta.round + ' ' + d.round + ' <span class="muted">(' + w + '–' + l + ' · ' + (p >= 0 ? '+' : '−') + aud(Math.abs(p)) + ')</span></h4>';
        h += '<table><thead><tr><th>Call</th><th>Model</th><th>Paid</th><th>CLV</th><th>P/L</th><th>Status</th></tr></thead><tbody>';
        d.bets.forEach((b) => {
          const cls = b.status === 'won' ? 'qual' : b.status === 'lost' ? 'bub' : '';
          h += '<tr class="' + cls + '"><td>' + esc(b.selection) + '</td><td class="c">' + pct(b.prob, 0) + '</td><td class="c">' + b.price.toFixed(2) + '</td><td class="c">' + sportClvCell(b) + '</td><td class="c">' + pnlCell(b) + '</td><td class="c">' + (BET_BADGE[b.status] || b.status) + '</td></tr>';
        });
        h += '</tbody></table>';
      });
    }
    box.innerHTML = h;
  });
}

/* ---------- Results & Learnings ---------- */
function renderLearnings() {
  const bk = data.bets;
  if (!bk || !bk.current) { el('learnHead').innerHTML = '<p class="muted">No betting history yet.</p>'; return; }
  const all = [...(bk.history || []).flatMap((d) => d.bets), ...bk.current.bets];
  const settled = all.filter((b) => b.status !== 'pending');
  const won = settled.filter((b) => b.status === 'won');
  const pnl = settled.reduce((s, b) => s + betPnl(b), 0);
  const staked = settled.reduce((s, b) => s + (b.stake ?? 100), 0);
  const pending = all.length - settled.length;
  const money = (v) => '<b class="' + (v >= 0 ? 'good' : 'bad') + '">' + (v >= 0 ? '+' : '−') + aud(Math.abs(v)) + '</b>';
  const card = (t, big, sub) => '<div class="card"><div class="muted">' + t + '</div><div class="bignum">' + big + '</div><div class="muted">' + (sub || '') + '</div></div>';
  el('learnHead').innerHTML = '<div class="cards">'
    + card('Settled calls', String(settled.length), won.length + ' landed · ' + (settled.length - won.length) + ' busted')
    + card('Hit rate', settled.length ? Math.round(won.length / settled.length * 100) + '%' : '—', 'high hit rate ≠ profit — see below')
    + card('Net P/L', money(pnl), 'on ' + aud(staked) + ' staked')
    + card('ROI', (staked ? (pnl / staked * 100).toFixed(1) : '0.0') + '%', '$100 flat stakes at locked prices')
    + card('Open positions', String(pending), aud(pending * 100) + ' riding')
    + '</div>';

  // -- category table (types + wildcard kinds), live --
  const CATS = [
    { label: 'Group crowns', f: (b) => b.settle.kind === 'group', verdict: '⭐ Keep — the star' },
    { label: 'Qualification calls', f: (b) => b.settle.kind === 'qualify', verdict: '✅ Keep' },
    { label: 'Match singles', f: (b) => b.type === 'single', verdict: '✅ Keep (edge-gated in v2)' },
    { label: 'Double chance', f: (b) => b.type === 'double', verdict: '✅ Keep (1.20 price floor in v2)' },
    { label: 'Anytime scorers', f: (b) => b.type === 'scorer', verdict: '🔧 Recalibrated in v2' },
    { label: 'Multis & combos', f: (b) => b.type === 'multi' || b.type === 'combo', verdict: '🔧 40% joint floor in v2' },
    { label: 'Quarter Club (last 8)', f: (b) => b.settle.kind === 'last8', verdict: '❌ Retired in v2' },
    { label: 'Outright steals', f: (b) => b.settle.kind === 'champion', verdict: '⏳ One open position max in v2' },
  ];
  let h = '<table><thead><tr><th>Category</th><th>Bets</th><th>Record</th><th>Hit</th><th>P/L</th><th>ROI</th><th>Verdict</th></tr></thead><tbody>';
  CATS.forEach((c) => {
    const bs = all.filter(c.f), st = bs.filter((b) => b.status !== 'pending');
    if (!bs.length) return;
    const w = st.filter((b) => b.status === 'won').length;
    const p = st.reduce((s, b) => s + betPnl(b), 0);
    const stk = st.reduce((s, b) => s + (b.stake ?? 100), 0);
    const cls = p > 50 ? 'qual' : p < -50 ? 'bub' : '';
    h += '<tr class="' + cls + '"><td><b>' + c.label + '</b></td><td class="c">' + bs.length + (bs.length - st.length ? ' <span class="muted">(' + (bs.length - st.length) + ' open)</span>' : '') + '</td>'
      + '<td class="c">' + w + '–' + (st.length - w) + '</td><td class="c">' + (st.length ? Math.round(w / st.length * 100) + '%' : '—') + '</td>'
      + '<td class="c">' + (st.length ? money(p) : '<span class="muted">—</span>') + '</td>'
      + '<td class="c">' + (stk ? ((p / stk * 100).toFixed(0) + '%') : '—') + '</td>'
      + '<td>' + c.verdict + '</td></tr>';
  });
  el('learnCats').innerHTML = h + '</tbody></table>';

  // -- calibration, live --
  const buckets = [[0, 0.35], [0.35, 0.5], [0.5, 0.65], [0.65, 0.8], [0.8, 1.01]];
  let cal = '<table><thead><tr><th>Model says</th><th>Bets settled</th><th>Model average</th><th>Actually landed</th><th>Read</th></tr></thead><tbody>';
  buckets.forEach(([lo, hi]) => {
    const bs = settled.filter((b) => b.prob >= lo && b.prob < hi);
    if (!bs.length) return;
    const w = bs.filter((b) => b.status === 'won').length;
    const claimed = bs.reduce((s, b) => s + b.prob, 0) / bs.length;
    const actual = w / bs.length;
    const gap = actual - claimed;
    const read = gap < -0.15 ? '<span class="bad">badly over-confident</span>' : gap > 0.12 ? '<span class="good">under-priced bankers</span>' : '<span class="muted">roughly honest</span>';
    cal += '<tr><td class="c">' + Math.round(lo * 100) + '–' + Math.round((hi > 1 ? 1 : hi) * 100) + '%</td><td class="c">' + bs.length + '</td>'
      + '<td class="c">' + pct(claimed, 0) + '</td><td class="c"><b>' + pct(actual, 0) + '</b></td><td>' + read + '</td></tr>';
  });
  el('learnCal').innerHTML = cal + '</tbody></table>';

  // -- Germany case study, live numbers --
  const touch = {};
  all.forEach((b) => {
    const ts = new Set();
    (function walk(s) { if (s.kind === 'multi') s.legs.forEach(walk); else if (s.team) ts.add(s.team); })(b.settle);
    ts.forEach((t) => {
      touch[t] = touch[t] || { n: 0, pnl: 0, open: 0 };
      touch[t].n++; touch[t].pnl += betPnl(b);
      if (b.status === 'pending') touch[t].open++;
    });
  });
  const worst = Object.entries(touch).sort((a, b) => a[1].pnl - b[1].pnl)[0];
  const mostOpen = Object.entries(touch).sort((a, b) => b[1].open - a[1].open)[0];
  el('learnCase').innerHTML = '<div class="prizebox">The model had <b>no memory between days</b>: every morning it re-generated its favourite theses from scratch, so a "good value" position was re-bet daily until it settled. Germany collected <b>'
    + (touch['Germany']?.n ?? 0) + ' bets for ' + money(touch['Germany']?.pnl ?? 0) + '</b> — including twelve identical "Quarter Club" calls that all died together when Paraguay won on penalties. '
    + 'Re-bets made up 41% of all turnover and earned nothing. Worst team overall: <b>' + esc(worst[0]) + '</b> (' + worst[1].n + ' bets, ' + money(worst[1].pnl) + ')'
    + (mostOpen && mostOpen[1].open > 3 ? ' · biggest live concentration: <b>' + esc(mostOpen[0]) + '</b> (' + mostOpen[1].open + ' open bets — capped at 3 for anything new)' : '')
    + '.</div>';

  // -- v2 rules (static) --
  el('learnRules').innerHTML = '<div class="legend">'
    + '1. <b>Never re-take an open position</b> — one bet per thesis until it settles.<br>'
    + '2. <b>Team exposure cap</b> — at most 3 open bets touching any one team.<br>'
    + '3. <b>Payout floor 1.20</b> — no more risking $1,900 to win $23 (seven old bets paid <i>less than the stake</i> on a win).<br>'
    + '4. <b>Never knowingly negative edge</b> — if the bookmakers price a bet below our model, we pass. 57 negative-edge bets won 88% of the time and still lost money; the 5 positive-edge bets went 5-for-5 at +79% ROI.<br>'
    + '5. <b>Quarter Club retired</b> (0 from 12, −$1,200), <b>multis need a 40%+ combined chance</b> (sub-50% calls went 1 from 17), and <b>scorer probabilities were shrunk</b> to their real-world hit rate.<br>'
    + '<span class="muted">Historical books are frozen as published — the record above includes every v1 mistake on purpose.</span></div>';

  // -- daily P/L, live --
  const days = [...(bk.history || []), bk.current];
  let dd = '<table><thead><tr><th>Day (AEST)</th><th>Bets</th><th>Settled</th><th>Day P/L</th><th>Running total</th></tr></thead><tbody>';
  let run = 0;
  days.forEach((day) => {
    const st = day.bets.filter((b) => b.status !== 'pending');
    const p = st.reduce((s, b) => s + betPnl(b), 0);
    run += p;
    dd += '<tr><td>' + esc(day.date) + '</td><td class="c">' + day.bets.length + '</td><td class="c">' + st.length + '</td>'
      + '<td class="c">' + money(p) + '</td><td class="c">' + money(run) + '</td></tr>';
  });
  el('learnDaily').innerHTML = dd + '</tbody></table>';
}

/* ---------- About ---------- */
function renderAbout() {
  const gbLive = data.sidePots?.goldenBoot?.live;
  const liveOdds = Object.keys(data.oddsOverride || {}).length > 0;
  const rankingsAsOf = data.sidePots?.darkHorse?.rankingsAsOf || 'April 2026 FIFA release';
  const rows = [
    ['⚽ Scores & fixtures', 'fixturedownload.com', 'All 104 matches with kick-off times, venues and final scores — including the winner of knockout ties decided on penalties. Fetched on every refresh.'],
    ['🟥 In-field statistics', 'ESPN (public JSON API)', 'Own goals, red cards, missed penalties (in regulation) and goalkeeper goals for the Chaos Pot, detected automatically from each completed match’s event feed. The admin can correct any mis-detection.'],
    ['💰 Tournament-winner odds', liveOdds ? 'The Odds API (live, averaged across US bookmakers)' : 'BetMGM via Yahoo Sports — snapshot of 9 June 2026', 'Drives the Win Odds tab, bracket predictions and the simulation’s team strengths.'],
    ['👟 Golden Boot odds', 'FanDuel / DraftKings / Oddschecker consensus, June 2026', 'Used once, to pick and tier the striker pool for the Golden Boot draw.'],
    ['🥅 Golden Boot goals', gbLive ? 'football-data.org (live scorer feed)' : 'Entered by the admin after each matchday', 'Each drawn striker’s tournament goal tally.'],
    ['🌍 FIFA rankings', 'FIFA Men’s World Ranking — ' + rankingsAsOf, 'Decides Dark Horse eligibility and tie-breaks. Frozen for the tournament.'],
    ['🔮 Projections', 'Our own Monte-Carlo simulation', data.sim.iterations.toLocaleString() + ' full-tournament simulations per refresh: Bradley-Terry match model from the betting odds (tempered so upsets happen at realistic rates), ~24% group-game draw rate, real results locked in as they arrive.'],
    ['🎲 High Risk Curnow Bets', 'Our model' + (Object.keys(data.oddsOverride || {}).length ? ' + The Odds API match prices' : ' (model-only — fair odds quoted as the price to beat)'), 'Daily top-10 calls mined from the simulation, match model, FIFA rank gaps and the Golden Boot board; frozen each AEST morning, settled automatically from results and the ESPN goal feed.'],
  ];
  let h = '<table><thead><tr><th>Data</th><th>Source</th><th>What it powers</th></tr></thead><tbody>';
  rows.forEach(([what, src, note]) => {
    h += '<tr><td style="white-space:nowrap"><b>' + what + '</b></td><td>' + esc(src) + '</td><td class="muted">' + esc(note) + '</td></tr>';
  });
  h += '</tbody></table>';
  h += '<div class="legend"><b>How the site updates</b><br>'
    + 'A scheduled job rebuilds everything three times a day (4pm, midnight and 8am AEST) — there’s nothing to press and nothing to install; just reload the page. '
    + 'Long-open tabs re-sync themselves on focus and every 30 minutes. After the final on 19 July the data freezes and the site keeps showing the end-of-tournament standings forever. '
    + 'Every refresh is recorded on the Change Log tab.<br><br>'
    + '<b>The draw</b> is locked: team owners live in a config file that the rebuild never touches. The Golden Boot strikers were dealt by a seeded random draw (reproducible from the seed) in five odds tiers, one striker per tier each, so every hand has the same spread of favourites and longshots.</div>';
  el('about').innerHTML = h;
}

/* ---------- Change Log ---------- */
function renderLog() {
  const rows = (data.log || []).slice().sort((a, b) => b.ts - a.ts);
  const last = rows[0];
  el('logSummary').innerHTML = last ? 'Last update: <b>' + esc(fmtAEST(last.ts)) + '</b> (' + esc(last.source) + ')' : 'No updates logged yet.';
  let h = '<table><thead><tr><th>When (AEST)</th><th>Source</th><th>What happened</th></tr></thead><tbody>';
  if (!rows.length) h += '<tr><td colspan="3" class="muted">Nothing logged yet.</td></tr>';
  rows.forEach((e) => {
    h += '<tr><td>' + esc(fmtAEST(e.ts)) + '</td><td><b>' + esc(e.source) + '</b></td><td>' + esc((e.matchesUpdated ? '+' + e.matchesUpdated + ' new scores · ' : '') + (e.note || '')) + '</td></tr>';
  });
  el('changelog').innerHTML = h + '</tbody></table>';
}

/* ---------- boot ---------- */
function renderAll() {
  // One broken section must not blank the whole site — isolate each renderer.
  [renderToday, renderLeaderboard, renderMyTeam, renderSummary,
    renderWildCard, renderWinOdds, renderProjections, renderModelMarket,
    renderGoldenBoot, renderDarkHorse, renderChaos, renderHighRiskBets,
    renderLearnings, renderSports, renderPot, renderFixtures, renderBracket, renderLog, renderAbout,
  ].forEach((fn) => {
    try { fn(); } catch (e) { console.error(fn.name + ' failed:', e); }
  });
  el('updated').textContent = 'Scores updated ' + fmtAEST(Date.parse(data.updatedAt))
    + (data.finished ? ' · final standings 🏆' : ' · auto-refreshes 4× a day');
}

async function loadData() {
  const r = await fetch('data.json', { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  data = await r.json();
  ctx = {
    teams: data.teams, fixtures: resolveFixtures(FIX, data.koTeams || {}), scores: data.scores,
    players: data.config.players, owners: data.config.owners,
    buyIn: data.config.buyIn, split: data.config.split,
  };
}

async function boot() {
  try {
    await loadData();
  } catch (e) {
    el('loaderr').innerHTML = '<div class="err"><b>Could not load data.json</b> — ' + esc(e.message) + '. The first scheduled build may not have run yet.</div>';
    el('updated').textContent = 'No data yet';
    return;
  }
  buildTabs();
  el('main').style.display = '';
  el('playerSel').addEventListener('change', function () { selPlayer = this.value; renderMyTeam(); });
  el('sumSel').addEventListener('change', function () { sumPlayer = this.value; renderSummary(); });
  el('roundSel').addEventListener('change', function () { selRound = this.value; renderBracket(); });
  const bgSel = el('betGroupSel');
  if (bgSel) bgSel.addEventListener('change', function () { betGroup = this.value; renderHighRiskBets(); });
  renderAll();
  tab('today');
  // keep long-open tabs in sync: refetch on focus and every 30 minutes
  let lastFetch = Date.now();
  const refetch = async () => {
    try { await loadData(); renderAll(); lastFetch = Date.now(); } catch { /* keep showing what we have */ }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastFetch > 5 * 60 * 1000) refetch();
  });
  setInterval(refetch, 30 * 60 * 1000);
}
boot();
