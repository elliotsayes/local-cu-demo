local sqlite3 = require("lsqlite3")

Db = sqlite3.open_memory()

Db:exec [[
  CREATE TABLE test (id INTEGER PRIMARY KEY, content);
  INSERT INTO test VALUES (NULL, 'Hello Lua');
  INSERT INTO test VALUES (NULL, 'Hello Sqlite3');
  INSERT INTO test VALUES (NULL, 'Hello ao!!!');
]]

return "Loaded Db"
