export const queryCmd = `
local s = ""

for row in Db:nrows("SELECT * FROM test") do
  s = s .. row.id .. ": " .. row.content .. "\\n"
end

return s
`