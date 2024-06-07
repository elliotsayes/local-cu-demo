export function createMessage(evalCmd: string) {
  return ({
    Target: 'AOS',
    Owner: 'FOOBAR',
    'Block-Height': '1000',
    Id: '1234xyxfoo',
    Module: 'WOOPAWOOPA',
    Tags: [
      { name: 'Action', value: 'Eval' }
    ],
    Data: evalCmd,
    From: 'FOOBAR',
    Timestamp: Date.now().toString(),
    Cron: false,
  })
}
