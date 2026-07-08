#!/usr/bin/env node
/* Server allow-list guard test (v7.21) — extracts the REAL validateGraphQL + allow-lists from server.js
   and runs the exact queries the app sends, plus negatives, against them. Mirrors the v7.14 method:
   prove the guard against real code, not memory. graphql's parse+visit are injected (same the server uses). */
const fs = require('fs');
const path = require('path');
const { parse, visit } = require('graphql');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// Pull the exact definition lines + the validateGraphQL function out of server.js.
function grabLine(re){ const m = src.match(re); if(!m) throw new Error('not found: '+re); return m[0]; }
function grabFn(name){
  const i = src.indexOf('function '+name+'('); if(i<0) throw new Error('fn not found: '+name);
  let j=src.indexOf('{',i), d=0,k=j; for(;k<src.length;k++){ if(src[k]==='{')d++; else if(src[k]==='}'){d--; if(!d)break;} }
  return src.slice(i,k+1);
}
const harness = [
  'const process={env:{}};',
  grabLine(/const MAIN_BOARD_ID\s*=[^\n]+/),
  grabLine(/const BATCH_BOARD_ID\s*=[^\n]+/),
  grabLine(/const CASTING_BOARD_ID =[^\n]+/),
  grabLine(/const CASTING_SUBITEM_BOARD_ID =[^\n]+/),
  grabLine(/const SANDBOX_SAVES_BOARD_ID =[^\n]+/),
  grabLine(/const ALLOWED_BOARD_IDS =[^\n]+/),
  grabLine(/const ALLOWED_QUERY_ROOTS =[^\n]+/),
  grabLine(/const ALLOWED_MUTATION_ROOTS = new Set\(\[[\s\S]*?\]\);/),
  grabFn('validateGraphQL'),
  'return validateGraphQL;'
].join('\n');
const validateGraphQL = new Function('parse','visit', harness)(parse, visit);

let n=0, fails=0;
function expect(label, query, vars, wantOk){
  n++; const r = validateGraphQL(query, vars);
  if(!!r.ok === wantOk) console.log('  ✓ '+label);
  else { fails++; console.log('  ✗ '+label+'  → got ok='+r.ok+(r.reason?(' ('+r.reason+')'):'')); }
}

const SAVES='18420711215';
console.log('[1] saves board — the app\'s real queries pass');
expect('read saves columns', `{boards(ids:[${SAVES}]){columns{id title type}}}`, {}, true);
expect('read saves items', `{boards(ids:[${SAVES}]){items_page(limit:200){items{id name updated_at column_values(ids:["long_text_x"]){text}}}}}`, {}, true);
expect('create_item on saves (vars)', `mutation($b:ID!,$n:String!,$c:JSON!){create_item(board_id:$b,item_name:$n,column_values:$c){id}}`, {b:SAVES,n:'x',c:'{}'}, true);
expect('delete_item (saved state)', `mutation($i:ID!){delete_item(item_id:$i){id}}`, {i:'123'}, true);
expect('change cols on saves (dup-ignore write)', `mutation($i:ID!,$b:ID!,$c:JSON!){change_multiple_column_values(item_id:$i,board_id:$b,column_values:$c){id}}`, {i:'1',b:SAVES,c:'{}'}, true);

console.log('[2] negatives still rejected');
expect('read a random board', `{boards(ids:[999999]){items_page{items{id}}}}`, {}, false);
expect('create_item on random board (vars)', `mutation($b:ID!){create_item(board_id:$b,item_name:"x",column_values:"{}"){id}}`, {b:'999999'}, false);
expect('foreign mutation root create_board', `mutation{create_board(board_name:"x",board_kind:public){id}}`, {}, false);
expect('two operations (smuggling)', `mutation{create_item(board_id:${SAVES},item_name:"x",column_values:"{}"){id}} query{me{id}}`, {}, false);

console.log('[3] existing behavior unregressed');
expect('casting rows read', `{boards(ids:[8533133380]){items_page(limit:500){items{id name}}}}`, {}, true);
expect('port create_subitem', `mutation($p:ID!,$n:String!){create_subitem(parent_item_id:$p,item_name:$n){id}}`, {p:'1',n:'TOP1'}, true);
expect('main tracker read', `{boards(ids:[3636652411]){items_page(limit:200){items{id}}}}`, {}, true);

console.log(`\n${n} assertions, ${fails} failed`);
process.exit(fails?1:0);
