'use strict';
const readline = require('node:readline/promises');
const { createTwitchChat } = require('../src/twitch-chat');
const { TwitchFault } = require('../src/twitch-storage');
const { REQUIRED } = require('../src/twitch-client');
async function run({ args, env = process.env, input = process.stdin, output = process.stdout, chat, confirm } = {}) {
  const command = args?.[0];
  if (args?.length !== 1 || !['preflight', 'register', 'reconcile', 'remove', 'refresh'].includes(command)) throw new TwitchFault('invalid_command');
  if (['register', 'remove', 'refresh'].includes(command)) {
    if (!input.isTTY || !output.isTTY) throw new TwitchFault('private_terminal_required');
    let terminal;
    try {
      const question = confirm || (prompt => { terminal = readline.createInterface({ input, output }); return terminal.question(prompt); });
      const answer = await question(`Type ${command.toUpperCase()} to authorize this Twitch-only operation: `);
      if (answer !== command.toUpperCase()) throw new TwitchFault('operation_cancelled');
    } finally { terminal?.close(); }
  }
  const service = chat || createTwitchChat({ env });
  let result;
  if (command === 'preflight') { await service.tokens.check({ refresh: false }); result = service.health(); }
  if (command === 'refresh') { await service.tokens.check({ refresh: true }); result = service.health(); }
  if (command === 'register') result = await service.register();
  if (command === 'reconcile') result = await service.reconcile();
  if (command === 'remove') result = await service.remove();
  output.write(JSON.stringify({ ok: true, ...result }) + '\n');
}
if (require.main === module) run({ args: process.argv.slice(2) }).catch(e => {
  // No process/environment/provider object is ever passed to the logger.
  console.error(JSON.stringify({ ok: false, category: e instanceof TwitchFault ? e.category : 'operation_unavailable',
    missingPermissions: e instanceof TwitchFault && Array.isArray(e.missingPermissions) ? REQUIRED.filter(scope => e.missingPermissions.includes(scope)) : [] })); process.exitCode = 1;
});
module.exports = { run };
