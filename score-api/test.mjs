// worker.js を、Node に入っている本物の SQLite で動かして確かめる
import { DatabaseSync } from 'node:sqlite';
import W from './worker.js';

const db = new DatabaseSync(':memory:');
let queries = 0;
const DB = {
  prepare(sql){
    return {
      _a: [],
      bind(...a){ this._a = a; return this; },
      async all(){ queries++; return { results: db.prepare(sql).all(...this._a), success: true }; },
      async first(){ queries++; return db.prepare(sql).get(...this._a) ?? null; },
      async run(){ queries++; const r = db.prepare(sql).run(...this._a);
        return { success: true, meta: { changes: Number(r.changes) } }; }
    };
  }
};
const env = { DB, ALLOW_ORIGIN: 'https://pdylplplp-stack.github.io', ADMIN_KEY: 'test-admin-key-123' };

function mk(method, path, body, head){
  return new Request('https://x.example' + path, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json', 'Origin': 'https://pdylplplp-stack.github.io' }, head || {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}
async function call(method, path, body, head){
  const r = await W.fetch(mk(method, path, body, head), env);
  let j; try { j = await r.clone().json(); } catch(e) { j = await r.text(); }
  return { status: r.status, body: j, cors: r.headers.get('Access-Control-Allow-Origin') };
}
let ng = 0;
function check(label, cond, extra){ if (!cond) ng++; console.log('  ' + (cond ? '' : '★ ') + label + (extra ? '　' + extra : '')); }

console.log('\n=== 名前の整え方 ===');
for (const [given, want] of [
  ['やまだ','やまだ'], ['  たろう  ','たろう'], ['','ななし'],
  ['あいうえおかきくけこさしすせそ','あいうえおかきくけこさし'],
  ['あ\u0000い','あい'], ['ばか',null], ['FUCKer',null]
]){
  const r = await call('POST','/submit',{ game:'tapioca', name:given, score:100 });
  const got = (r.status === 400) ? null : r.body.name;
  check('「'+given.replace(/\u0000/g,'□')+'」→'+(got===null?'弾いた':'「'+got+'」（'+got.length+'文字）'),
        got === want, got === want ? '' : '狙い '+want);
}

console.log('\n=== 点数の検査 ===');
for (const [sc, okWant] of [[0,true],[123456,true],[-1,false],[1e9,false],['9999',false],[null,false],[NaN,false]]){
  const r = await call('POST','/submit',{ game:'tapioca', name:'てすと', score:sc });
  check('点数 '+JSON.stringify(sc)+' → '+(r.status===200?'受理':'弾いた'), (r.status===200)===okWant);
}

console.log('\n=== 並び順と順位 ===');
db.exec('DELETE FROM scores');
for (const [n,s] of [['あ',100],['い',300],['う',200]]) await call('POST','/submit',{game:'tapioca',name:n,score:s});
let b = await call('GET','/board?game=tapioca');
check('点数は大きい順: '+b.body.list.map(e=>e.n+e.s).join(' '), b.body.list[0].s===300 && b.body.list[2].s===100);
let r2 = await call('POST','/submit',{game:'tapioca',name:'え',score:250});
check('250点を出した人の順位は2位（出た値 '+r2.body.rank+'）', r2.body.rank===2);
for (const [n,s] of [['あ',50.5],['い',30.2],['う',40.0]]) await call('POST','/submit',{game:'wadachi-1',name:n,score:s});
b = await call('GET','/board?game=wadachi-1');
check('タイムは小さい順: '+b.body.list.map(e=>e.n+e.s).join(' '), b.body.list[0].s===30.2 && b.body.list[2].s===50.5);
r2 = await call('POST','/submit',{game:'wadachi-1',name:'え',score:35.0});
check('35秒の人の順位は2位（出た値 '+r2.body.rank+'）', r2.body.rank===2);

console.log('\n=== 同じ名前は良いほうだけ残す ===');
db.exec('DELETE FROM scores');
await call('POST','/submit',{game:'tapioca',name:'やまだ',score:500});
let r3 = await call('POST','/submit',{game:'tapioca',name:'やまだ',score:200});
check('点数 500→200 を出しても残るのは '+r3.body.best+'／件数 '+r3.body.list.length,
      r3.body.best===500 && r3.body.list.length===1);
await call('POST','/submit',{game:'wadachi-1',name:'やまだ',score:40});
r3 = await call('POST','/submit',{game:'wadachi-1',name:'やまだ',score:55});
check('タイム 40→55 を出しても残るのは '+r3.body.best, r3.body.best===40);
r3 = await call('POST','/submit',{game:'wadachi-1',name:'やまだ',score:33});
check('タイム 33 なら更新される: '+r3.body.best, r3.body.best===33);

console.log('\n=== 上位20件だけ返す ===');
db.exec('DELETE FROM scores');
for (let i=0;i<30;i++) await call('POST','/submit',{game:'tapioca',name:'p'+i,score:1000+i});
b = await call('GET','/board?game=tapioca');
check('30人入れて、返るのは '+b.body.list.length+'件', b.body.list.length===20);
check('1位は最高点 '+b.body.list[0].s, b.body.list[0].s===1029);
r3 = await call('POST','/submit',{game:'tapioca',name:'よわい',score:1});
check('最下位の人の順位 '+r3.body.rank+'／上位に入ったか '+r3.body.inTop, r3.body.rank===31 && r3.body.inTop===false);

console.log('\n=== 手入れ（合言葉）===');
// 「別のゲームは消えていない」を見るため、別ゲームにも1件入れておく
await call('POST','/submit',{game:'wadachi-1',name:'べつ',score:44});
let r = await call('POST','/admin/clear',{game:'tapioca'},{'x-admin-key':'wrong'});
check('合言葉が違う → '+r.status, r.status===401);
r = await call('POST','/admin/remove',{game:'tapioca',name:'p29'},{'x-admin-key':'test-admin-key-123'});
check('名前を指定して消す → '+r.body.removed+'件', r.body.removed===1);
r = await call('POST','/admin/clear',{game:'tapioca'},{'x-admin-key':'test-admin-key-123'});
b = await call('GET','/board?game=tapioca');
check('空にする → 消えた '+r.body.removed+'件／残り '+b.body.list.length+'件', b.body.list.length===0);
b = await call('GET','/board?game=wadachi-1');
check('別のゲームは消えていない（'+b.body.list.length+'件）', b.body.list.length>0);

console.log('\n=== 相手先の許可（CORS）===');
check('許した相手には '+b.cors, b.cors==='https://pdylplplp-stack.github.io');

console.log('\n1回遊ぶときの問い合わせ回数の目安: 送信1回あたり約' +
  Math.round(queries / 60) + '回（全体で ' + queries + ' 回）');
console.log(ng ? '\n★ ' + ng + '件おかしい' : '\nすべて通った');
