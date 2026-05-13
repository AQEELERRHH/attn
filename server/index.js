import express from 'express';
import { ethers } from 'ethers';
import cors from 'cors';
import crypto from 'crypto';
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../.env') });

import * as walletService from './walletService.js';
import * as db from './db.js';

const app = express();
app.use(cors());
app.use(express.json());

const provider = new ethers.JsonRpcProvider(process.env.ARC_RPC_URL);

const ABI = [
  "function registerCreator(uint256 _minBid, string[] calldata _tags, address _agentWallet, string calldata _profileURI) external",
  "function getCreatorProfile(address _creator) view returns (bool registered, uint256 minBid, string[] tags, address agentWallet, string profileURI)",
  "function getCreatorsByTag(string calldata _tag) view returns (address[])",
  "function getCreatorBids(address _creator) view returns (uint256[])",
  "function bids(uint256) view returns (address bidder, address creator, uint256 amount, string message, bool isPrivate, uint8 status, uint256 createdAt, string reply)",
  "function acceptBid(uint256 _bidId, string calldata _reply) external",
  "function rejectBid(uint256 _bidId) external",
  "function placeBid(address _creator, uint256 _amount, string calldata _message, bool _isPrivate) external returns (uint256)",
  "event BidPlaced(uint256 indexed bidId, address indexed bidder, address indexed creator, uint256 amount)"
];

const contract = new ethers.Contract(
  process.env.CONTRACT_ADDRESS,
  ABI,
  provider
);

const webhookEvents = [];

// ── Health check ──
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    chain: 'Arc Testnet',
    contract: process.env.CONTRACT_ADDRESS,
    timestamp: new Date().toISOString(),
  });
});

// ── POST /register ──
app.post('/register', async (req, res) => {
  const { name, email, role, minBid, tags, profileURI } = req.body;
  if (!name || !role) {
    return res.status(400).json({ error: 'name and role required' });
  }
  try {
    console.log(`Provisioning wallet for ${name}...`);
    const wallet = await walletService.provisionUserWallet(name);
    const userData = {
      name,
      email: email || '',
      role,
      walletId: wallet.walletId,
      walletAddress: wallet.address,
      minBid: minBid || 5,
      tags: tags || [],
      profileURI: profileURI || '',
      registeredAt: new Date().toISOString(),
      onChain: false,
    };
    db.saveUser(wallet.address, userData);
    res.json({
      success: true,
      wallet: {
        address: wallet.address,
        walletId: wallet.walletId,
        blockchain: wallet.blockchain,
      },
      user: userData,
      message: 'Wallet provisioned. Fund it with testnet USDC from faucet.circle.com',
    });
  } catch (err) {
    console.error('Registration error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /register/onchain ──
app.post('/register/onchain', async (req, res) => {
  const { walletAddress, minBid, tags, profileURI } = req.body;
  if (!walletAddress) {
    return res.status(400).json({ error: 'walletAddress required' });
  }
  const user = db.getUser(walletAddress);
  if (!user) {
    return res.status(404).json({ error: 'User not found. Register first.' });
  }
  try {
    const minBidUnits = ethers.parseUnits((minBid || user.minBid).toString(), 6);
    const userTags = tags || user.tags;
    const uri = profileURI || user.profileURI || '';
    const result = await walletService.executeContractCall(
      user.walletId,
      process.env.CONTRACT_ADDRESS,
      'registerCreator(uint256,string[],address,string)',
      [minBidUnits.toString(), userTags, walletAddress, uri]
    );
    db.saveUser(walletAddress, { ...user, onChain: true, onChainTxId: result.txId });
    res.json({
      success: true,
      txId: result.txId,
      status: result.status,
      message: 'Registration submitted to Arc. Confirming...',
    });
  } catch (err) {
    console.error('On-chain registration error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /wallet/:address ──
app.get('/wallet/:address', async (req, res) => {
  const address = req.params.address.toLowerCase();
  const user = db.getUser(address);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  try {
    const balances = await walletService.getWalletBalance(user.walletId);
    res.json({
      address,
      walletId: user.walletId,
      name: user.name,
      role: user.role,
      balances,
      onChain: user.onChain,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  const address = req.params.address;
  try {
    const [registered, minBid, tags, agentWallet, profileURI] =
      await contract.getCreatorProfile(address);
    if (!registered) {
      return res.status(404).json({ error: 'Creator not registered on-chain' });
    }
    const user = db.getUser(address) || {};
    res.json({
      address,
      registered,
      minBid: ethers.formatUnits(minBid, 6),
      tags,
      agentWallet,
      profileURI,
      name: user.name || 'Anonymous',
      email: user.email || '',
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
    const bids = [];
    for (const bidId of bidIds) {
      const bid = await contract.bids(bidId);
      bids.push({
        bidId: bidId.toString(),
        bidder: bid.bidder,
        amount: ethers.formatUnits(bid.amount, 6),
        message: bid.message,
        isPrivate: bid.isPrivate,
        status: Number(bid.status),
        createdAt: Number(bid.createdAt),
        reply: bid.reply,
      });
    }
    res.json({ address, bids });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /bid ──
app.post('/bid', async (req, res) => {
  const { bidderAddress, creatorAddress, amount, message, isPrivate } = req.body;
  if (!bidderAddress || !creatorAddress || !amount || !message) {
    return res.status(400).json({ error: 'bidderAddress, creatorAddress, amount, message required' });
  }
  const bidder = db.getUser(bidderAddress);
  if (!bidder) {
    return res.status(404).json({ error: 'Bidder not found. Register first.' });
  }
  try {
    const amountUnits = ethers.parseUnits(amount.toString(), 6);
    await walletService.executeContractCall(
      bidder.walletId,
      '0x3600000000000000000000000000000000000000',
      'approve(address,uint256)',
      [process.env.CONTRACT_ADDRESS, amountUnits.toString()]
    );
    const result = await walletService.executeContractCall(
      bidder.walletId,
      process.env.CONTRACT_ADDRESS,
      'placeBid(address,uint256,string,bool)',
      [creatorAddress, amountUnits.toString(), message, isPrivate || false]
    );
    res.json({
      success: true,
      txId: result.txId,
      status: result.status,
      message: `Bid of $${amount} USDC placed on ${creatorAddress}`,
    });
  } catch (err) {
    console.error('Bid error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /bid/accept ──
app.post('/bid/accept', async (req, res) => {
  const { creatorAddress, bidId, reply } = req.body;
  if (!creatorAddress || bidId === undefined || !reply) {
    return res.status(400).json({ error: 'creatorAddress, bidId, reply required' });
  }
  const creator = db.getUser(creatorAddress);
  if (!creator) {
    return res.status(404).json({ error: 'Creator not found' });
  }
  try {
    const result = await walletService.executeContractCall(
      creator.walletId,
      process.env.CONTRACT_ADDRESS,
      'acceptBid(uint256,string)',
      [bidId.toString(), reply]
    );
    res.json({ success: true, txId: result.txId, status: result.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /bid/reject ──
app.post('/bid/reject', async (req, res) => {
  const { creatorAddress, bidId } = req.body;
  const creator = db.getUser(creatorAddress);
  if (!creator) {
    return res.status(404).json({ error: 'Creator not found' });
  }
  try {
    const result = await walletService.executeContractCall(
      creator.walletId,
      process.env.CONTRACT_ADDRESS,
      'rejectBid(uint256)',
      [bidId.toString()]
    );
    res.json({ success: true, txId: result.txId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /webhook/circle ──
app.post('/webhook/circle', (req, res) => {
  const signature = req.headers['x-circle-signature'];
  const payload = JSON.stringify(req.body);
  if (process.env.CIRCLE_WEBHOOK_SECRET) {
    const expected = crypto
      .createHmac('sha256', process.env.CIRCLE_WEBHOOK_SECRET)
      .update(payload)
      .digest('hex');
    if (signature !== expected) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }
  const event = req.body;
  console.log(`Webhook received: ${event.type}`);
  webhookEvents.push({ ...event, receivedAt: new Date().toISOString() });
  if (event.type === 'transactions.inbound') {
    handleInboundPayment(event.data);
  }
  res.json({ received: true });
});

async function handleInboundPayment(data) {
  try {
    const toAddress = data?.toAddress?.toLowerCase();
    if (!toAddress) return;
    const user = db.getUser(toAddress);
    if (!user) return;
    console.log(`Payment received for ${user.name} (${toAddress})`);
  } catch (err) {
    console.error('Webhook handler error:', err.message);
  }
}

// ── GET /webhook/events ──
app.get('/webhook/events', (req, res) => {
  res.json({ events: webhookEvents.slice(-20) });
});

// ── GET /users ──
app.get('/users', (req, res) => {
  const users = db.getAllUsers();
  res.json({
    count: users.length,
    users: users.map(u => ({
      name: u.name,
      role: u.role,
      address: u.walletAddress,
      onChain: u.onChain,
      tags: u.tags,
      registeredAt: u.registeredAt,
    })),
  });
});

// ── Start ──
const PORT = process.env.PORT || 3001;

async function start() {
  try {
    await walletService.initWalletSet();
    app.listen(PORT, () => {
      console.log(`Attn. server running on port ${PORT}`);
      console.log(`Contract: ${process.env.CONTRACT_ADDRESS}`);
      console.log(`RPC: ${process.env.ARC_RPC_URL}`);
      console.log(`Circle wallets: ready`);
    });
  } catch (err) {
    console.error('Server failed to start:', err.message);
    process.exit(1);
  }
}

start();