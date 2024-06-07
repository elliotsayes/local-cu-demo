Db:exec [[
  INSERT INTO test VALUES (NULL, 'Hello extra!!!');
]]

return "Appended Db"
