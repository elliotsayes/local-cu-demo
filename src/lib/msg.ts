export function createMessage(processId: string, owner: string, evalCmd: string) {
  return ({
    process: processId,
    Process: processId,
    Target: processId,
    Owner: owner,
    'Block-Height': '1000',
    Id: owner,
    Module: 'WOOPAWOOPA',
    Tags: [
      { name: 'Action', value: 'Query' }
    ],
    Data: evalCmd,
    From: owner,
    Timestamp: Date.now().toString(),
    Cron: false,
  })
}
