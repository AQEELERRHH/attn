// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "forge-std/Script.sol";
import "../src/Attn.sol";

contract DeployAttn is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerPrivateKey);

        // USDC contract address on Arc Testnet
        address usdc = 0x3600000000000000000000000000000000000000;
        
        // Platform fee = 200 (2%)
        uint256 platformFee = 200;

        Attn attn = new Attn(usdc, platformFee);

        console.log("Attn deployed at:", address(attn));

        vm.stopBroadcast();
    }
}