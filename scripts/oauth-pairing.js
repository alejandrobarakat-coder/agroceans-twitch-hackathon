// Local filesystem approval only. No environment secrets or network requests.
const readline = require('node:readline/promises');
const { createPairingStore } = require('../src/oauth-pairing');

async function run({ args, input, output, store = createPairingStore(), createTerminal = options => readline.createInterface(options) }) {
  if (args.length !== 1 || !['approve', 'revoke-all'].includes(args[0])) throw Error('Usage');
  if (!input.isTTY || !output.isTTY) throw Error('Private interactive terminal required');
  if (args[0] === 'revoke-all') {
    store.revokeAll(); output.write('Pairing requests revoked. OAuth credentials unchanged.\n'); return;
  }
  const terminal = createTerminal({ input, output, terminal: true });
  try {
    // Prompt rather than argv: avoid saving the identifier in shell history.
    const id = (await terminal.question('Request ID from your own browser: ')).trim();
    const record = store.inspect(id);
    if (!record || record.status !== 'pending') throw Error('Unavailable request');
    output.write(`Comparison phrase: ${record.phrase}\nExpires: ${new Date(record.expires).toISOString()}\n`);
    output.write('Compare with your own browser. Do not approve an unsolicited request.\n');
    const confirmation = await terminal.question('Type the complete matching phrase to approve (anything else cancels): ');
    if (confirmation !== record.phrase) { output.write('Approval cancelled.\n'); return; }
    if (!store.approve(id, confirmation)) throw Error('Unavailable request');
    output.write('Approved once. Continue in the original browser.\n');
  } finally { terminal.close(); }
}
if (require.main === module) {
  run({ args: process.argv.slice(2), input: process.stdin, output: process.stdout }).catch(() => {
    console.error('Pairing command failed. Use approve or revoke-all in a private interactive terminal; verify request expiry and private storage ownership.');
    process.exitCode = 1;
  });
}
module.exports = { run };
