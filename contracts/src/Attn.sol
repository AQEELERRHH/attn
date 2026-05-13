// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract Attn is ReentrancyGuard {

    // ── USDC token on Arc Testnet ──
    IERC20 public immutable usdc;

    // ── Platform fee (200 = 2%) ──
    uint256 public platformFee;
    address public owner;

    // ── Creator profile ──
    struct Creator {
        bool registered;
        uint256 minBid;
        string[] tags;
        address agentWallet;
        string profileURI;
    }

    // ── Bid (ERC-8183 aligned) ──
    struct Bid {
        address bidder;
        address creator;
        uint256 amount;
        string message;
        bool isPrivate;
        uint8 status; // 0=pending 1=accepted 2=rejected 3=refunded
        uint256 createdAt;
        string reply;
    }

    // ── Storage ──
    mapping(address => Creator) public creators;
    mapping(uint256 => Bid) public bids;
    mapping(address => uint256[]) public creatorBids;
    mapping(string => address[]) public tagIndex;

    uint256 public bidCount;
    uint256 public totalVolume;

    // ── Events ──
    event CreatorRegistered(address indexed creator, uint256 minBid, string[] tags);
    event BidPlaced(uint256 indexed bidId, address indexed bidder, address indexed creator, uint256 amount);
    event BidAccepted(uint256 indexed bidId, string reply, uint256 payout);
    event BidRejected(uint256 indexed bidId);
    event BidRefunded(uint256 indexed bidId);

    constructor(address _usdc, uint256 _platformFee) {
        usdc = IERC20(_usdc);
        platformFee = _platformFee;
        owner = msg.sender;
    }

    // ── Register as creator ──
    function registerCreator(
        uint256 _minBid,
        string[] calldata _tags,
        address _agentWallet,
        string calldata _profileURI
    ) external {
        require(_minBid > 0, "Min bid must be > 0");

        // Remove old tags if updating
        if (creators[msg.sender].registered) {
            string[] memory oldTags = creators[msg.sender].tags;
            for (uint i = 0; i < oldTags.length; i++) {
                _removeFromTagIndex(oldTags[i], msg.sender);
            }
        }

        creators[msg.sender] = Creator({
            registered: true,
            minBid: _minBid,
            tags: _tags,
            agentWallet: _agentWallet,
            profileURI: _profileURI
        });

        for (uint i = 0; i < _tags.length; i++) {
            tagIndex[_tags[i]].push(msg.sender);
        }

        emit CreatorRegistered(msg.sender, _minBid, _tags);
    }

    // ── Place a bid ──
    function placeBid(
        address _creator,
        uint256 _amount,
        string calldata _message,
        bool _isPrivate
    ) external nonReentrant returns (uint256) {
        require(creators[_creator].registered, "Creator not registered");
        require(_amount >= creators[_creator].minBid, "Below minimum bid");
        require(bytes(_message).length > 0, "Message required");

        // Pull USDC from bidder into escrow
        require(
            usdc.transferFrom(msg.sender, address(this), _amount),
            "USDC transfer failed"
        );

        uint256 bidId = bidCount++;
        bids[bidId] = Bid({
            bidder: msg.sender,
            creator: _creator,
            amount: _amount,
            message: _message,
            isPrivate: _isPrivate,
            status: 0,
            createdAt: block.timestamp,
            reply: ""
        });

        creatorBids[_creator].push(bidId);
        totalVolume += _amount;

        emit BidPlaced(bidId, msg.sender, _creator, _amount);
        return bidId;
    }

    // ── Accept a bid ──
    function acceptBid(
        uint256 _bidId,
        string calldata _reply
    ) external nonReentrant {
        Bid storage bid = bids[_bidId];
        require(bid.creator == msg.sender, "Not your bid");
        require(bid.status == 0, "Bid not pending");
        require(bytes(_reply).length >= 10, "Reply too short");

        bid.status = 1;
        bid.reply = _reply;

        // Calculate payout (amount minus platform fee)
        uint256 fee = (bid.amount * platformFee) / 10000;
        uint256 payout = bid.amount - fee;

        // Send USDC to creator
        require(usdc.transfer(msg.sender, payout), "Payout failed");
        // Send fee to owner
        if (fee > 0) {
            require(usdc.transfer(owner, fee), "Fee transfer failed");
        }

        emit BidAccepted(_bidId, _reply, payout);
    }

    // ── Reject a bid ──
    function rejectBid(uint256 _bidId) external nonReentrant {
        Bid storage bid = bids[_bidId];
        require(bid.creator == msg.sender, "Not your bid");
        require(bid.status == 0, "Bid not pending");

        bid.status = 2;
        require(usdc.transfer(bid.bidder, bid.amount), "Refund failed");

        emit BidRejected(_bidId);
    }

    // ── Claim refund after 14 days ──
    function claimRefund(uint256 _bidId) external nonReentrant {
        Bid storage bid = bids[_bidId];
        require(bid.status == 0, "Bid not pending");
        require(
            block.timestamp >= bid.createdAt + 14 days,
            "14 days not passed"
        );

        bid.status = 3;
        require(usdc.transfer(bid.bidder, bid.amount), "Refund failed");

        emit BidRefunded(_bidId);
    }

    // ── Read: get all bids for a creator ──
    function getCreatorBids(address _creator)
        external view returns (uint256[] memory)
    {
        return creatorBids[_creator];
    }

    // ── Read: get creators by tag ──
    function getCreatorsByTag(string calldata _tag)
        external view returns (address[] memory)
    {
        return tagIndex[_tag];
    }

    // ── Read: get creator profile ──
    function getCreatorProfile(address _creator)
        external view returns (Creator memory)
    {
        return creators[_creator];
    }

    // ── Internal: remove from tag index ──
    function _removeFromTagIndex(string memory _tag, address _creator) internal {
        address[] storage list = tagIndex[_tag];
        for (uint i = 0; i < list.length; i++) {
            if (list[i] == _creator) {
                list[i] = list[list.length - 1];
                list.pop();
                break;
            }
        }
    }

    // ── Owner: update platform fee ──
    function updateFee(uint256 _newFee) external {
        require(msg.sender == owner, "Not owner");
        require(_newFee <= 1000, "Max 10%");
        platformFee = _newFee;
    }
}