// worker.js の中身を、偽の保管庫で動かして確かめる
import W from './worker.js';

const KV = {
  _d: {},
  writes: 0, reads: 0,
  async get(k){ this.reads++; return this._d[k] ?? null; },
  async put(k, v){ this.writes++; this._d[k] = v; }
};
const env = { SCORES: KV, ALLOW_ORIGIN: 'https://pdylplplp-stack.github.io', ADMIN_KEY: 'test-admin-key-123' };

function req(method, path, body, head){
  return new Request('https://x.example' + path, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json', 'Origin': 'https://pdylplplp-stack.github.io' }, head || {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}
async function call(method, path, body, head){
  const r = await W.fetch(req(method, path, body, head), env);
  let j = null;
  try { j = await r.clone().json(); } catch(e) { j = await r.text(); }
  return { status: r.status, body: j, cors: r.headers.get('Access-Control-Allow-Origin') };
}

let ng = 0;
function check(label, cond, extra){
  if (!cond) ng++;
  console.log('  ' + (cond ? '' : '★ ') + label + (extra ? '　' + extra : ''));
}

console.log('\n=== 名前の整え方 ===');
for (const [given, want] of [
  ['やまだ', 'やまだ'],
  ['  たろう  ', 'たろう'],
  ['', 'ななし'],
  ['あいうえおかきくけこさしすせそ', 'あいうえおかきくけこさし'],   // 12文字で切る
  ['あ\u0000い', 'あい'],
  ['ばか', null],
  ['FUCKer', null]
]){
  const r = await call('POST','/submit',{ game:'tapioca', name:given, score:100 });
  const got = (r.status === 400) ? null : r.body.name;
  check('「' + given.replace(/\u0000/g,'□') + '」 → ' + (got === null ? '弾いた' : '「' + got + '」'),
        got === want, got === want ? '' : '（狙い ' + want + '）');
}

console.log('\n=== 点数の検査 ===');
for (const [sc, okWant] of [[0,true],[123456,true],[-1,false],[1e9,false],['abc',false],[null,false]]){
  const r = await call('POST','/submit',{ game:'tapioca', name:'てすと', score:sc });
  check('点数 ' + JSON.stringify(sc) + ' → ' + (r.status === 200 ? '受理' : '弾いた'),
        (r.status === 200) === okWant);
}
const bad = await call('POST','/submit',{ game:'そんなゲームない', name:'a', score:1 });
check('知らないゲーム → ' + (bad.status === 400 ? '弾いた' : '通った'), bad.status === 400);

console.log('\n=== 並び順 ===');
KV._d = {};
for (const [n,s] of [['あ',100],['い',300],['う',200]]) await call('POST','/submit',{game:'tapioca',name:n,score:s});
let b = await call('GET','/board?game=tapioca');
check('点数は大きい順: ' + b.body.list.map(e=>e.n+e.s).join(' '),
      b.body.list[0].s === 300 && b.body.list[2].s === 100);
for (const [n,s] of [['あ',50.5],['い',30.2],['う',40.0]]) await call('POST','/submit',{game:'wadachi-1',name:n,score:s});
b = await call('GET','/board?game=wadachi-1');
check('タイムは小さい順: ' + b.body.list.map(e=>e.n+e.s).join(' '),
      b.body.list[0].s === 30.2 && b.body.list[2].s === 50.5);

console.log('\n=== 同じ名前は良いほうだけ残す ===');
KV._d = {};
await call('POST','/submit',{game:'tapioca',name:'やまだ',score:500});
await call('POST','/submit',{game:'tapioca',name:'やまだ',score:200});
b = await call('GET','/board?game=tapioca');
check('点数：500のあと200を出しても ' + b.body.list[0].s + ' が残り、件数 ' + b.body.list.length,
      b.body.list.length === 1 && b.body.list[0].s === 500);
KV._d = {};
await call('POST','/submit',{game:'wadachi-1',name:'やまだ',score:40});
await call('POST','/submit',{game:'wadachi-1',name:'やまだ',score:55});
b = await call('GET','/board?game=wadachi-1');
check('タイム：40のあと55を出しても ' + b.body.list[0].s + ' が残る',
      b.body.list.length === 1 && b.body.list[0].s === 40);

console.log('\n=== 上位20件に入らない点数は書き込まない（無料枠の節約）===');
KV._d = {}; KV.writes = 0;
for (let i = 0; i < 25; i++) await call('POST','/submit',{game:'tapioca',name:'p'+i,score:1000+i});
const w1 = KV.writes;
await call('POST','/submit',{game:'tapioca',name:'よわい',score:1});
const w2 = KV.writes;
b = await call('GET','/board?game=tapioca');
check('25人ぶん入れたあと、下位の点数を出す → 書き込み ' + w1 + ' → ' + w2 + '（増えなければOK）', w1 === w2);
check('順位表は20件に保たれている（いま ' + b.body.list.length + '件）', b.body.list.length === 20);

console.log('\n=== 手入れ（合言葉）===');
let r = await call('POST','/admin/clear',{game:'tapioca'},{ 'x-admin-key':'wrong-key' });
check('合言葉が違う → ' + r.status + ' で断る', r.status === 401);
r = await call('POST','/admin/remove',{game:'tapioca',name:'p24'},{ 'x-admin-key':'test-admin-key-123' });
check('名前を指定して消す → ' + (r.body.removed || 0) + '件', r.status === 200 && r.body.removed === 1);
r = await call('POST','/admin/clear',{game:'tapioca'},{ 'x-admin-key':'test-admin-key-123' });
b = await call('GET','/board?game=tapioca');
check('空にする → いま ' + b.body.list.length + '件', b.body.list.length === 0);

console.log('\n=== 相手先の許可（CORS）===');
check('許した相手には ' + b.cors, b.cors === 'https://pdylplplp-stack.github.io');

console.log('\n' + (ng ? '★ ' + ng + '件おかしい' : 'すべて通った'));
