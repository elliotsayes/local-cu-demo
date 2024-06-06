import AoLoader from '@permaweb/ao-loader'
import { Buffer } from 'buffer'

const processId = `IN3T2l6QERA6d65XGW5asx2JWX7VrOQ3HIbwQvKVBQo`;
const moduleId = `GYrbbe0VbHim_7Hi6zrOpHQXrSQz07XNtwCnfbFo2I0`;

const env = {
  Process: {
    Id: 'AOS',
    Owner: 'FOOBAR',
    Tags: [
      { name: 'Name', value: 'Thomas' }
    ]
  }
}
const msg = (cmd) => ({
  Target: 'AOS',
  Owner: 'FOOBAR',
  'Block-Height': '1000',
  Id: '1234xyxfoo',
  Module: 'WOOPAWOOPA',
  Tags: [
    { name: 'Action', value: 'Eval' }
  ],
  Data: cmd
})


export async function testLoader() {
  const moduleBlob = await fetch(`https://arweave.net/${moduleId}`)
    .then(async (response) => new Buffer(await response.arrayBuffer()));
  const handle = await AoLoader(moduleBlob, { format: 'wasm32-unknown-emscripten2' })
  const run1 = `
  local sqlite3 = require("lsqlite3")

  db = sqlite3.open_memory()

  db:exec[[
    CREATE TABLE test (id INTEGER PRIMARY KEY, content);
    INSERT INTO test VALUES (NULL, 'Hello Lua');
    INSERT INTO test VALUES (NULL, 'Hello Sqlite3');
    INSERT INTO test VALUES (NULL, 'Hello ao!!!');
  ]]
  return "ok"
  `
  const msg1 = msg(run1)
  
  const res = await handle(null,
    msg1,
    env,
  );
  return res;
}