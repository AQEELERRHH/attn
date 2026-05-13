const express = require('express');
const { ethers } = require('ethers');
const cors = require('cors');
require('dotenv').config({ path: '../.env' });

const app = express();
app.use(cors());
app.use(express.json());

const provider = new ethers.JsonRpcProvider(process.env.ARC_RPC_URL);

const ABI = [
  "function getCreatorProfile(address _creator) view returns (bool registered, uint256 minBid, string[] tags, address agentWallet, string profileURI)",
  "function getCreatorsByTag(string calldata _tag) view returns (address[])",
  "function getCreatorBids(address _creator) view returns (uint256[])",
  "function placeBid(address _creator, uint256 _amount, string calldata _message, bool _isPrivate) returns (uint256)",
  "function acceptBid(uint256 _bidId, string calldata _reply) external",
  "function rejectBid(uint256 _bidId) external",
  "function claimRefund(uint256 _bidId) external"
];

const contract = new ethers.Contract(
  process.env.CONTRACT_ADDRESS,
  ABI,
  provider
);

const paidAccess = new Map();

// ── Health check ──
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    chain: 'Arc Testnet',
    contract: process.env.CONTRACT_ADDRESS
  });
});

// ── GET /registry?tag=solidity ──
app.get('/registry', async (req, res) => {
  try {
    const tag = req.query.tag || '';
    const creators = await contract.getCreatorsByTag(tag);
    res.json({ tag, creators, count: creators.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /creator/:address ──
app.get('/creator/:address', async (req, res) => {
  const address = req.params.address.toLowerCase();
  const payerKey = req.headers['x-payer'] || 'anonymous';
  const accessKey = `${payerKey}:${address}`;

  try {
    const [registered, minBid, tags, agentWallet, profileURI] = await contract.getCreatorProfile(address);

    if (!registered) {
      return res.status(404).json({ error: 'Creator not found' });
    }

    if (!paidAccess.has(accessKey)) {
      return res.status(402).json({
        error: 'Payment required',
        x402: {
          version: 1,
          accepts: [{
            scheme: 'exact',
            network: 'arc-testnet',
            maxAmountRequired: '100000',
            resource: `${req.protocol}://${req.get('host')}${req.path}`,
            description: `Access profile for ${address}`,
            mimeType: 'application/json',
            payTo: process.env.PLATFORM_WALLET || process.env.CONTRACT_ADDRESS,
            maxTimeoutSeconds: 300,
            asset: '0x3600000000000000000000000000000000000000',
            extra: { name: 'USDC', version: '2' }
          }]
        }
      });
    }

    res.json({
      address,
      registered,
      minBid: ethers.formatUnits(minBid, 6),
      tags,
      agentWallet,
      profileURI
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /creator/:address/pay ──
app.post('/creator/:address/pay', async (req, res) => {
  const address = req.params.address.toLowerCase();
  const { txHash, payerAddress } = req.body;

  if (!txHash || !payerAddress) {
    return res.status(400).json({ error: 'txHash and payerAddress required' });
  }

  try {
    const tx = await provider.getTransaction(txHash);
    if (!tx) {
      return res.status(400).json({ error: 'Transaction not found' });
    }

    const accessKey = `${payerAddress.toLowerCase()}:${address}`;
    paidAccess.set(accessKey, { txHash, timestamp: Date.now() });

    const [registered, minBid, tags, agentWallet, profileURI] = await contract.getCreatorProfile(address);

    res.json({
      success: true,
      address,
      registered,
      minBid: ethers.formatUnits(minBid, 6),
      tags,
      agentWallet,
      profileURI
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /bids/:address ──
app.get('/bids/:address', async (req, res) => {
  try {
    const address = req.params.address;
    const bidIds = await contract.getCreatorBids(address);
    res.json({ address, bidIds: bidIds.map(id => id.toString()) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Attn. server running on port ${PORT}`);
  console.log(`Contract: ${process.env.CONTRACT_ADDRESS}`);
  console.log(`RPC: ${process.env.ARC_RPC_URL}`);
});