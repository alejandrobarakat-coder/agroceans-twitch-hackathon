// Local filesystem capability management only: no environment secrets or network access.
const { createCapabilityStore, ORIGIN } = require('../src/oauth-bootstrap');
async function main() {
  const command = process.argv[2];
  const store = createCapabilityStore();
  if (command === 'mint') {
    if (!process.stdout.isTTY) throw new Error('Use an interactive private VPS terminal; output redirection is disabled');
    const token = await store.mint();
    console.log(`Open privately within two minutes; do not share or record this link:\n${ORIGIN}/auth/twitch/bootstrap#${token}`);
  } else if (command === 'revoke-all') {
    await store.revokeAll();
    console.log('Outstanding bootstrap capabilities revoked. OAuth credentials were not changed.');
  } else throw new Error('Usage: node scripts/oauth-bootstrap.js mint|revoke-all');
}
main().catch(() => { console.error('Bootstrap command failed. Use mint in a private TTY, or revoke-all; verify private directory ownership and permissions.'); process.exitCode = 1; });
