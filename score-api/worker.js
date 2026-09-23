// ============================================================
//  順位表の預かり所（Cloudflare Worker）
//
//  やること
//    GET  /board?game=tapioca        … 上位の一覧を返す
//    POST /submit                    … 名前と点数を受け取る
//    POST /admin/remove              … 1件消す（合言葉が要る）
//    POST /admin/clear               … そのゲームを空にする（合言葉が要る）
//
//  預かり方
//    ゲーム1本につき KV のキーを1つだけ使い、上位20件をまとめて入れておく。
//    上位に入らない点数は書き込まないので、無料枠の「書き込み1,000回/日」を
//    使い切りにくい。
//
//  合言葉（ADMIN_KEY）と許す相手（ALLOW_ORIGIN）は、この file には書かない。
//  Cloudflare の画面で「環境変数」として設定する。
// ============================================================

const TOP = 20;          // 順位表に残す件数
const NAME_MAX = 12;     // 名前の長さ

// 取り扱うゲームと、点数の決まり
//   order: 'desc' = 大きいほうが上位（点数）／'asc' = 小さいほうが上位（タイム）
const GAMES = {
  'tapioca':   { order: 'desc', max: 99999999, unit: '点' },
  'tou-tower': { order: 'desc', max: 100000,   unit: 'm' },
  'tou-well':  { order: 'desc', max: 100000,   unit: 'm' },
  'wadachi-1': { order: 'asc',  max: 3600,     unit: '秒' },
  'wadachi-2': { order: 'asc',  max: 3600,     unit: '秒' },
  'wadachi-3': { order: 'asc',  max: 3600,     unit: '秒' },
  'sokki-0':   { order: 'desc', max: 3000,     unit: '文字/分' },
  'sokki-1':   { order: 'desc', max: 3000,     unit: '文字/分' },
  'sokki-2':   { order: 'desc', max: 3000,     unit: '文字/分' },
  'gyaku-0':   { order: 'asc',  max: 3600,     unit: '秒' },
  'gyaku-1':   { order: 'asc',  max: 3600,     unit: '秒' },
  'gyaku-2':   { order: 'asc',  max: 3600,     unit: '秒' },
  'gyaku-3':   { order: 'asc',  max: 3600,     unit: '秒' }
};

// 名前に使わせない語句。網であって、完全ではない。
// 目に余るものが出たら /admin/remove で消す前提。
const NG = [
  'しね', '死ね', 'ころす', '殺す', 'きもい', 'うざい', 'ばか', 'アホ', 'あほ',
  'ブス', 'ぶす', 'デブ', 'でぶ', 'ハゲ', 'はげ', 'クズ', 'くず', 'カス',
  'fuck', 'shit', 'bitch', 'cunt', 'nigg', 'asshole', 'dick'
];

// ------------------------------------------------------------
function cors(env, req) {
  const allow = (env.ALLOW_ORIGIN || '*').split(',').map(s => s.trim());
  const origin = req.headers.get('Origin') || '';
  const ok = allow.includes('*') ? '*' : (allow.includes(origin) ? origin : allow[0] || '');
  return {
    'Access-Control-Allow-Origin': ok,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,x-admin-key',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(body, status, head) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, head || {})
  });
}

// 名前を整える。使えない文字を落とし、長さを詰める。
function cleanName(raw) {
  let s = String(raw == null ? '' : raw);
  // 制御文字・見えない文字を落とす（正規表現に生の制御文字を書かないため、コードで判定）
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || c === 0x7F) continue;
    if (c >= 0x200B && c <= 0x200F) continue;
    if (c === 0x2028 || c === 0x2029 || c === 0xFEFF) continue;
    out += ch;
  }
  s = out;
  s = s.replace(/\s+/g, ' ').trim();
  s = Array.from(s).slice(0, NAME_MAX).join('');
  if (!s) s = 'ななし';
  const low = s.toLowerCase();
  for (const w of NG) {
    if (low.includes(w.toLowerCase())) return null;   // 弾く
  }
  return s;
}

function sortBoard(list, order) {
  const sign = (order === 'asc') ? 1 : -1;
  return list.slice().sort((a, b) => (a.s - b.s) * sign || a.t - b.t);
}

async function readBoard(env, game) {
  const raw = await env.SCORES.get('board:' + game);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch (e) { return []; }
}

// ------------------------------------------------------------
export default {
  async fetch(req, env) {
    const head = cors(env, req);

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: head });

    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    // --- 説明（人が開いたとき） ---
    if (path === '/' && req.method === 'GET') {
      return new Response(
        '順位表の預かり所です。\n' +
        '  GET  /board?game=<ゲーム名>\n' +
        '  POST /submit  {game, name, score}\n' +
        '取り扱うゲーム: ' + Object.keys(GAMES).join(', ') + '\n',
        { headers: Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, head) }
      );
    }

    // --- 一覧を返す ---
    if (path === '/board' && req.method === 'GET') {
      const game = url.searchParams.get('game') || '';
      if (!GAMES[game]) return json({ error: 'そのゲームは取り扱っていません' }, 400, head);
      const list = await readBoard(env, game);
      return json({
        game: game,
        unit: GAMES[game].unit,
        order: GAMES[game].order,
        list: sortBoard(list, GAMES[game].order).slice(0, TOP)
      }, 200, Object.assign({ 'Cache-Control': 'public, max-age=20' }, head));
    }

    // --- 点数を受け取る ---
    if (path === '/submit' && req.method === 'POST') {
      let body;
      try { body = await req.json(); } catch (e) { return json({ error: '中身が読めません' }, 400, head); }

      const game = String(body.game || '');
      const rule = GAMES[game];
      if (!rule) return json({ error: 'そのゲームは取り扱っていません' }, 400, head);

      const name = cleanName(body.name);
      if (name === null) return json({ error: 'その名前は使えません' }, 400, head);

      // 数値そのものだけ受ける（null や '' は Number() で 0 になってしまうため型で弾く）
      if (typeof body.score !== 'number' || !isFinite(body.score)) {
        return json({ error: '点数がおかしいです' }, 400, head);
      }
      const score = body.score;
      if (score < 0 || score > rule.max) {
        return json({ error: '点数がおかしいです' }, 400, head);
      }
      const s = Math.round(score * 100) / 100;   // 小数第2位まで（タイム用）

      const list = await readBoard(env, game);

      // 同じ名前は良いほうだけ残す
      const others = list.filter(e => e.n !== name);
      const mine = list.filter(e => e.n === name);
      const best = mine.length
        ? (rule.order === 'asc' ? Math.min(mine[0].s, s) : Math.max(mine[0].s, s))
        : s;

      const merged = sortBoard(others.concat([{ n: name, s: best, t: Date.now() }]), rule.order);
      const kept = merged.slice(0, TOP);
      const rank = kept.findIndex(e => e.n === name && e.s === best);

      // 上位に入らなかったときは書き込まない（無料枠を節約）
      let stored = false;
      const changed = mine.length ? (best !== mine[0].s) : (rank >= 0);
      if (rank >= 0 && changed) {
        await env.SCORES.put('board:' + game, JSON.stringify(kept));
        stored = true;
      }

      return json({
        ok: true,
        stored: stored,
        rank: rank >= 0 ? rank + 1 : null,
        name: name,
        list: kept
      }, 200, head);
    }

    // --- 手入れ（合言葉が要る） ---
    if (path.startsWith('/admin/') && req.method === 'POST') {
      const key = req.headers.get('x-admin-key') || '';
      if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
        return json({ error: '合言葉が違います' }, 401, head);
      }
      let body;
      try { body = await req.json(); } catch (e) { return json({ error: '中身が読めません' }, 400, head); }
      const game = String(body.game || '');
      if (!GAMES[game]) return json({ error: 'そのゲームは取り扱っていません' }, 400, head);

      if (path === '/admin/clear') {
        await env.SCORES.put('board:' + game, '[]');
        return json({ ok: true, cleared: game }, 200, head);
      }
      if (path === '/admin/remove') {
        const name = String(body.name || '');
        const list = await readBoard(env, game);
        const kept = list.filter(e => e.n !== name);
        if (kept.length === list.length) return json({ ok: true, removed: 0 }, 200, head);
        await env.SCORES.put('board:' + game, JSON.stringify(kept));
        return json({ ok: true, removed: list.length - kept.length }, 200, head);
      }
    }

    return json({ error: '見つかりません' }, 404, head);
  }
};
