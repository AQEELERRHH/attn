const { ethers } = require('ethers');
const fetch = require('node-fetch');
require('dotenv').config({ path: '../.env' });

const provider = new ethers.JsonRpcProvider(process.env.ARC_RPC_URL);

const ABI = [
  "function getCreatorBids(address _creator) view returns (uint256[])",
  "function bids(uint256) view returns (address bidder, address creator, uint256 amount, string message, bool isPrivate, uint8 status, uint256 createdAt, string reply)",
  "function acceptBid(uint256 _bidId, string calldata _reply) external",
  "function rejectBid(uint256 _bidId) external",
  "function claimRefund(uint256 _bidId) external"
];

const wallet = new ethers.Wallet(process.env.CREATOR_PRIVATE_KEY, provider);
const contract = new ethers.Contract(process.env.CONTRACT_ADDRESS, ABI, wallet);

const processedBids = new Set();

// ── Score a bid using AI ──
async function scoreBid(message, bidAmount, minBid) {
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
          content: `You are a creator agent. Score this incoming bid message.
          
Bid amount: $${bidAmount} USDC
Minimum bid: $${minBid} USDC
Message: "${message}"

Score from 0-10 based on:
- Relevance and professionalism (0-4)
- Bid amount vs minimum (0-3)  
- Message quality and clarity (0-3)

Return ONLY valid JSON, nothing else:
{"score": 8, "recommendation": "ACCEPT", "reason": "Professional outreach with good budget"}`
        }],
        max_tokens: 150
      })
    });

    const data = await response.json();
    const text = data.choices[0].message.content.trim();
    return JSON.parse(text);
  } catch (err) {
    console.log('AI scoring failed, using rule-based scoring');
    // Fallback: rule-based scoring
    const amountScore = bidAmount >= minBid * 2 ? 3 : bidAmount >= minBid * 1.5 ? 2 : 1;
    const messageScore = message.length > 50 ? 3 : message.length > 20 ? 2 : 1;
    const score = amountScore + messageScore + 3;
    return {
      score,
      recommendation: score >= 7 ? 'ACCEPT' : score >= 5 ? 'QUEUE' : 'REJECT',
      reason: 'Rule-based scoring (AI unavailable)'
    };
  }
}

// ── Generate a reply using AI ──
async function generateReply(message, bidAmount) {
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
          content: `Write a short, professional reply accepting this message. 
Keep it under 200 characters. Be warm but concise.
Original message: "${message}"
Just write the reply, nothing else.`
        }],
        max_tokens: 100
      })
    });

    const data = await response.json();
    return data.choices[0].message.content.trim();
  } catch (err) {
    return `Thank you for reaching out. I have received your message and look forward to connecting.`;
  }
}

// ── Check for expired bids and refund ──
async function checkExpiredBids(creatorAddress) {
  try {
    const bidIds = await contract.getCreatorBids(creatorAddress);
    const now = Math.floor(Date.now() / 1000);
    const fourteenDays = 14 * 24 * 60 * 60;

    for (const bidId of bidIds) {
      const bid = await contract.bids(bidId);
      if (bid.status === 0n && (now - Number(bid.createdAt)) >= fourteenDays) {
        console.log(`Triggering refund for expired bid ${bidId}`);
        const tx = await contract.claimRefund(bidId);
        await tx.wait();
        console.log(`Refund sent for bid ${bidId}`);
      }
    }
  } catch (err) {
    console.log('Error checking expired bids:', err.message);
  }
}

// ── Main polling loop ──
async function pollInbox() {
  const creatorAddress = wallet.address;
  console.log(`Creator Agent active for: ${creatorAddress}`);

  try {
    const bidIds = await contract.getCreatorBids(creatorAddress);
    console.log(`Found ${bidIds.length} total bids`);

    for (const bidId of bidIds) {
      const bidIdStr = bidId.toString();

      if (processedBids.has(bidIdStr)) continue;

      const bid = await contract.bids(bidId);

      // Only process pending bids
      if (bid.status !== 0n) {
        processedBids.add(bidIdStr);
        continue;
      }

      const bidAmount = parseFloat(ethers.formatUnits(bid.amount, 6));
      const minBid = parseFloat(ethers.formatUnits(
        await contract.getCreatorBids(creatorAddress).then(() => bid.amount),
        6
      ));

      console.log(`\nNew bid #${bidIdStr}: $${bidAmount} USDC`);
      console.log(`Message: ${bid.message}`);

      // Score the bid
      const scoring = await scoreBid(bid.message, bidAmount, 5);
      console.log(`AI Score: ${scoring.score}/10 — ${scoring.recommendation}`);
      console.log(`Reason: ${scoring.reason}`);

      if (scoring.recommendation === 'ACCEPT') {
        // Generate reply and accept
        const reply = await generateReply(bid.message, bidAmount);
        console.log(`Auto-accepting with reply: ${reply}`);

        try {
          const tx = await contract.acceptBid(bidId, reply);
          await tx.wait();
          console.log(`✅ Bid ${bidIdStr} accepted — USDC released`);
        } catch (err) {
          console.log(`Failed to accept bid: ${err.message}`);
        }

      } else if (scoring.recommendation === 'REJECT') {
        console.log(`Auto-rejecting bid ${bidIdStr}`);
        try {
          const tx = await contract.rejectBid(bidId);
          await tx.wait();
          console.log(`❌ Bid ${bidIdStr} rejected — USDC refunded`);
        } catch (err) {
          console.log(`Failed to reject bid: ${err.message}`);
        }

      } else {
        console.log(`📋 Bid ${bidIdStr} queued for manual review`);
      }

      processedBids.add(bidIdStr);
    }

    // Check for expired bids every cycle
    await checkExpiredBids(creatorAddress);

  } catch (err) {
    console.log('Poll error:', err.message);
  }
}

// ── Start polling every 30 seconds ──
console.log('Starting Creator Agent...');
pollInbox();
setInterval(pollInbox, 30000);