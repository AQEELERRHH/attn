const { ethers } = require('ethers');
const fetch = require('node-fetch');
require('dotenv').config({ path: '../.env' });

const provider = new ethers.JsonRpcProvider(process.env.ARC_RPC_URL);

const ABI = [
  "function getCreatorsByTag(string calldata _tag) view returns (address[])",
  "function getCreatorProfile(address _creator) view returns (bool registered, uint256 minBid, string[] tags, address agentWallet, string profileURI)",
  "function placeBid(address _creator, uint256 _amount, string calldata _message, bool _isPrivate) returns (uint256)",
  "event BidPlaced(uint256 indexed bidId, address indexed bidder, address indexed creator, uint256 amount)"
];

const wallet = new ethers.Wallet(process.env.BIDDER_PRIVATE_KEY, provider);
const contract = new ethers.Contract(process.env.CONTRACT_ADDRESS, ABI, wallet);

// ── Agent config — change these to test different goals ──
const AGENT_CONFIG = {
  goal: process.env.AGENT_GOAL || "Find Web3 developers building on Arc network",
  dailyBudget: parseFloat(process.env.AGENT_DAILY_BUDGET || "50"),
  maxBidPerCreator: parseFloat(process.env.AGENT_MAX_BID || "15"),
  minFitScore: parseInt(process.env.AGENT_MIN_SCORE || "7"),
  searchTags: (process.env.AGENT_TAGS || "web3,solidity,arc,developer").split(','),
  message: process.env.AGENT_MESSAGE || "Hi, we are building on Arc and would love to connect with developers in the ecosystem."
};

let spentToday = 0;
let bidsPlaced = [];

// ── Evaluate creator fit using AI ──
async function evaluateCreator(creatorAddress, profile, tags) {
  try {
    const response = await fetch('https://api.aisa.one/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.AISA_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{
          role: 'user',
          content: `You are a bidder agent. Evaluate if this creator matches our goal.

Goal: ${AGENT_CONFIG.goal}
Creator address: ${creatorAddress}
Creator tags: ${tags.join(', ')}
Minimum bid: $${ethers.formatUnits(profile.minBid, 6)} USDC
Profile URI: ${profile.profileURI || 'none'}

Score fit from 0-10 and suggest bid amount.
Daily budget remaining: $${(AGENT_CONFIG.dailyBudget - spentToday).toFixed(2)}
Max bid per creator: $${AGENT_CONFIG.maxBidPerCreator}

Return ONLY valid JSON, nothing else:
{"score": 8, "bidAmount": 12, "reason": "Strong Arc developer match", "proceed": true}`
        }],
        max_tokens: 150
      })
    });

    const data = await response.json();
    const text = data.choices[0].message.content.trim();
    return JSON.parse(text);
  } catch (err) {
    console.log('AI evaluation failed, using rule-based');
    // Fallback rule-based
    const tagMatches = tags.filter(t =>
      AGENT_CONFIG.searchTags.some(st => st.toLowerCase() === t.toLowerCase())
    ).length;
    const score = Math.min(10, tagMatches * 3 + 2);
    const minBidNum = parseFloat(ethers.formatUnits(profile.minBid, 6));
    const bidAmount = Math.min(
      AGENT_CONFIG.maxBidPerCreator,
      Math.max(minBidNum, minBidNum * 1.2)
    );
    return {
      score,
      bidAmount: parseFloat(bidAmount.toFixed(2)),
      reason: `${tagMatches} matching tags`,
      proceed: score >= AGENT_CONFIG.minFitScore
    };
  }
}

// ── Place a bid on a creator ──
async function bidOnCreator(creatorAddress, bidAmount, message) {
  try {
    const amountInUnits = ethers.parseUnits(bidAmount.toString(), 6);

    // First approve USDC spending
    const usdcABI = ["function approve(address spender, uint256 amount) returns (bool)"];
    const usdcContract = new ethers.Contract(
      '0x3600000000000000000000000000000000000000',
      usdcABI,
      wallet
    );

    console.log(`Approving $${bidAmount} USDC...`);
    const approveTx = await usdcContract.approve(
      process.env.CONTRACT_ADDRESS,
      amountInUnits
    );
    await approveTx.wait();
    console.log('USDC approved');

    // Place the bid
    const tx = await contract.placeBid(
      creatorAddress,
      amountInUnits,
      message,
      false
    );
    const receipt = await tx.wait();
    console.log(`✅ Bid placed — tx: ${receipt.hash}`);

    spentToday += bidAmount;
    bidsPlaced.push({ creatorAddress, bidAmount, txHash: receipt.hash });

    return receipt.hash;
  } catch (err) {
    console.log(`Failed to place bid: ${err.message}`);
    return null;
  }
}

// ── Main agent run ──
async function runBidderAgent() {
  console.log('\n=== Bidder Agent Run ===');
  console.log(`Goal: ${AGENT_CONFIG.goal}`);
  console.log(`Daily budget: $${AGENT_CONFIG.dailyBudget} | Spent: $${spentToday}`);
  console.log(`Searching tags: ${AGENT_CONFIG.searchTags.join(', ')}`);

  const budgetRemaining = AGENT_CONFIG.dailyBudget - spentToday;
  if (budgetRemaining <= 0) {
    console.log('Daily budget exhausted. Stopping.');
    return;
  }

  // Discover creators by tag
  const discovered = new Set();
  for (const tag of AGENT_CONFIG.searchTags) {
    try {
      const creators = await contract.getCreatorsByTag(tag);
      creators.forEach(c => discovered.add(c));
      console.log(`Tag "${tag}": found ${creators.length} creators`);
    } catch (err) {
      console.log(`Error searching tag ${tag}: ${err.message}`);
    }
  }

  console.log(`Total unique creators discovered: ${discovered.size}`);

  if (discovered.size === 0) {
    console.log('No creators found yet. Will check again next cycle.');
    return;
  }

  // Evaluate each creator
  for (const creatorAddress of discovered) {
    // Skip if already bid on this creator
    if (bidsPlaced.some(b => b.creatorAddress === creatorAddress)) {
      console.log(`Already bid on ${creatorAddress}, skipping`);
      continue;
    }

    // Check budget
    if (spentToday >= AGENT_CONFIG.dailyBudget) {
      console.log('Budget reached, stopping');
      break;
    }

    try {
      const [registered, minBid, tags, agentWallet, profileURI] =
        await contract.getCreatorProfile(creatorAddress);

      if (!registered) continue;

      const minBidNum = parseFloat(ethers.formatUnits(minBid, 6));
      console.log(`\nEvaluating ${creatorAddress}`);
      console.log(`Tags: ${tags.join(', ')} | Min bid: $${minBidNum}`);

      const evaluation = await evaluateCreator(creatorAddress, { minBid, profileURI }, tags);
      console.log(`Fit score: ${evaluation.score}/10 — ${evaluation.reason}`);

      if (!evaluation.proceed || evaluation.score < AGENT_CONFIG.minFitScore) {
        console.log(`Score too low (${evaluation.score}), skipping`);
        continue;
      }

      // Make sure bid is above minimum
      const finalBid = Math.max(minBidNum, Math.min(
        evaluation.bidAmount,
        AGENT_CONFIG.maxBidPerCreator,
        AGENT_CONFIG.dailyBudget - spentToday
      ));

      console.log(`Bidding $${finalBid} USDC on ${creatorAddress}`);
      await bidOnCreator(creatorAddress, finalBid, AGENT_CONFIG.message);

    } catch (err) {
      console.log(`Error evaluating ${creatorAddress}: ${err.message}`);
    }
  }

  console.log(`\n=== Run complete. Total spent today: $${spentToday} ===`);
}

// ── Start ──
console.log('Starting Bidder Agent...');
console.log(`Wallet: ${wallet.address}`);
runBidderAgent();
setInterval(runBidderAgent, 60000);