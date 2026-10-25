'use strict';
// Only source-verified GET APIs. No address lookup, account data, signing or broadcasts.
const { AgroExplorerClient, JsonApi } = require('../src/ecosystem');
async function main() {
  const explorer = new AgroExplorerClient(process.env.AGRO_EXPLORER_URL);
  const chain = await explorer.summary();
  const tx = await explorer.tipTransaction();
  const wallet = new JsonApi(process.env.AGRO_PUBLIC_WALLET_URL);
  const health = await wallet.get('health');
  if (health.service !== 'agrocoin-public-wallet' || health.custody !== false) throw new Error('Unexpected wallet service');
  console.log(JSON.stringify({ chainHeight: chain.blockHeight, explorerTransactionVerified: true, transactionConfirmations: tx.confirmations, noncustodialWalletHealthy: true, paymentsAttempted: false }));
}
main().catch(() => { console.error('Read-only verification failed; verify configured API availability. No payment attempted.'); process.exitCode = 1; });
