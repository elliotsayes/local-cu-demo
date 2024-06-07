local sqlite3 = require("lsqlite3")

Db = sqlite3.open_memory()

Db:exec [[
  CREATE TABLE test (id INTEGER PRIMARY KEY, content);
  INSERT INTO test VALUES (NULL, 'Hello Lua');
  INSERT INTO test VALUES (NULL, 'Hello Sqlite3');
  INSERT INTO test VALUES (NULL, 'Hello ao!!!');
]]

Handlers.add(
  "Query",
  Handlers.utils.hasMatchingTag("Action", "Query"),
  function(msg)
    local s = ""
    for row in Db:nrows("SELECT * FROM test") do
      s = s .. row.id .. ": " .. row.content .. "\n"
    end
    print(s)
    Send({
      Target = msg.From,
      Data = s
    })
  end
)

return "Loaded Db"
