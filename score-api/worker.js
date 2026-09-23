// ============================================================
//  順位表の預かり所（Cloudflare Worker ＋ D1）
//
//  やること
//    GET  /board?game=tapioca        … 上位の一覧を返す
//    POST /submit                    … 名前と点数を受け取る
//    POST /admin/remove              … 1件消す（合言葉が要る）
//    POST /admin/clear               … そのゲームを空にする（合言葉が要る）
//
//  なぜ D1 か
//    KV は書いた内容が行き渡るまで時間がかかるため、二人がほぼ同時に
//    点数を出すと片方が消えることがある。D1 は書いた内容がすぐ確実に
//    反映されるので、順位表にはこちらが向く。
//
//  つなぐもの（Cloudflare の画面で設定する。ここには書かない）
//    D1 database … 変数名 DB
//    ALLOW_ORIGIN（Text）  … 許す相手
//    ADMIN_KEY（Secret）   … 手入れ用の合言葉
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

// 表が無ければ作る（初回だけ働く）
async function ensure(env) {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS scores (game TEXT NOT NULL, name TEXT NOT NULL, ' +
    'score REAL NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (game, name))'
  ).run();
}

async function board(env, game) {
  const dir = GAMES[game].order === 'asc' ? 'ASC' : 'DESC';
  const r = await env.DB
    .prepare('SELECT name, score, at FROM scores WHERE game = ? ORDER BY score ' + dir + ', at ASC LIMIT ' + TOP)
    .bind(game).all();
  return (r.results || []).map(row => ({ n: row.name, s: row.score, t: row.at }));
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
        '順位表の預かり所です。（D1）\n' +
        '  GET  /board?game=<ゲーム名>\n' +
        '  POST /submit  {game, name, score}\n' +
        '取り扱うゲーム: ' + Object.keys(GAMES).join(', ') + '\n',
        { headers: Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, head) }
      );
    }

    if (!env.DB) {
      return json({ error: 'D1 がつながっていません。変数名が DB になっているか確認してください' }, 500, head);
    }
    try {
      await ensure(env);
    } catch (e) {
      return json({ error: '表が用意できません: ' + (e && e.message) }, 500, head);
    }

    // --- 一覧を返す ---
    if (path === '/board' && req.method === 'GET') {
      const game = url.searchParams.get('game') || '';
      if (!GAMES[game]) return json({ error: 'そのゲームは取り扱っていません' }, 400, head);
      return json({
        game: game,
        unit: GAMES[game].unit,
        order: GAMES[game].order,
        list: await board(env, game)
      }, 200, head);
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
      if (body.score < 0 || body.score > rule.max) {
        return json({ error: '点数がおかしいです' }, 400, head);
      }
      const s = Math.round(body.score * 100) / 100;   // 小数第2位まで（タイム用）

      // 同じ名前は良いほうだけ残す。
      // 読んでから書くのではなく、1回の命令で入れ替えるので、
      // 二人が同時に出しても取りこぼさない。
      const better = rule.order === 'asc' ? '<' : '>';
      await env.DB.prepare(
        'INSERT INTO scores (game, name, score, at) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(game, name) DO UPDATE SET score = excluded.score, at = excluded.at ' +
        'WHERE excluded.score ' + better + ' scores.score'
      ).bind(game, name, s, Date.now()).run();

      // いまの持ち点と順位
      const mine = await env.DB
        .prepare('SELECT score FROM scores WHERE game = ? AND name = ?')
        .bind(game, name).first();
      const best = mine ? mine.score : s;

      const cnt = await env.DB
        .prepare('SELECT COUNT(*) AS c FROM scores WHERE game = ? AND score ' + better + ' ?')
        .bind(game, best).first();
      const rank = (cnt ? cnt.c : 0) + 1;

      return json({
        ok: true,
        name: name,
        best: best,
        rank: rank,
        inTop: rank <= TOP,
        list: await board(env, game)
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
        const r = await env.DB.prepare('DELETE FROM scores WHERE game = ?').bind(game).run();
        return json({ ok: true, cleared: game, removed: r && r.meta ? r.meta.changes : null }, 200, head);
      }
      if (path === '/admin/remove') {
        const name = String(body.name || '');
        const r = await env.DB.prepare('DELETE FROM scores WHERE game = ? AND name = ?')
          .bind(game, name).run();
        return json({ ok: true, removed: r && r.meta ? r.meta.changes : null }, 200, head);
      }
    }

    return json({ error: '見つかりません' }, 404, head);
  }
};
