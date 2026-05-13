import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { v4 as uuidv4 } from 'uuid';

let client;
let walletSetId;

function getClient() {
  if (!client) {
    client = initiateDeveloperControlledWalletsClient({
      apiKey: process.env.CIRCLE_API_KEY,
      entitySecret: process.env.CIRCLE_ENTITY_SECRET,
    });
  }
  return client;
}

export async function initWalletSet() {
  try {
    const c = getClient();
    const response = await c.createWalletSet({ name: 'Attn-Users' });
    walletSetId = response.data?.walletSet?.id;
    console.log(`Wallet set initialized: ${walletSetId}`);
    return walletSetId;
  } catch (err) {
    console.error('Failed to init wallet set:', err.message);
    throw err;
  }
}

export async function provisionUserWallet(userName) {
  if (!walletSetId) await initWalletSet();
  try {
    const c = getClient();
    const response = await c.createWallets({
      walletSetId,
      blockchains: ['ARC-TESTNET'],
      count: 1,
      accountType: 'EOA',
      metadata: [{ name: userName || 'Attn User', refId: uuidv4() }],
    });
    const wallet = response.data?.wallets?.[0];
    if (!wallet) throw new Error('Wallet creation failed');
    console.log(`Wallet provisioned for ${userName}: ${wallet.address}`);
    return {
      walletId: wallet.id,
      address: wallet.address,
      blockchain: wallet.blockchain,
      state: wallet.state,
    };
  } catch (err) {
    console.error('Failed to provision wallet:', err.message);
    throw err;
  }
}

export async function getWalletBalance(walletId) {
  try {
    const c = getClient();
    const response = await c.getWalletTokenBalance({ id: walletId });
    return response.data?.tokenBalances || [];
  } catch (err) {
    console.error('Failed to get balance:', err.message);
    return [];
  }
}

export async function executeContractCall(walletId, contractAddress, abiFunction, params) {
  try {
    const c = getClient();
    const response = await c.createContractExecutionTransaction({
      walletId,
      contractAddress,
      abiFunctionSignature: abiFunction,
      abiParameters: params,
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    });
    const txId = response.data?.id;
    console.log(`Contract call submitted: ${txId}`);
    return { txId, status: response.data?.state };
  } catch (err) {
    console.error('Contract call failed:', err.message);
    throw err;
  }
}

export async function transferUSDC(walletId, toAddress, amount) {
  try {
    const c = getClient();
    const response = await c.createTransaction({
      walletId,
      tokenAddress: '0x3600000000000000000000000000000000000000',
      destinationAddress: toAddress,
      amounts: [amount.toString()],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    });
    return { txId: response.data?.id, state: response.data?.state };
  } catch (err) {
    console.error('USDC transfer failed:', err.message);
    throw err;
  }
}

export async function getTransactionStatus(txId) {
  try {
    const c = getClient();
    const response = await c.getTransaction({ id: txId });
    return { state: response.data?.state, txHash: response.data?.txHash };
  } catch (err) {
    console.error('Failed to get tx status:', err.message);
    throw err;
  }
}