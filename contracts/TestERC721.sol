// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract TestERC721 is ERC721 {
    uint256 public nextId = 1;

    struct OwnerCheckpoint {
        uint48 blockNumber;
        address owner;
    }
    mapping(uint256 => OwnerCheckpoint[]) private _ownerCheckpoints;

    constructor() ERC721("Test NFT", "TNFT") {}

    function mint(address to) external returns (uint256 tokenId) {
        tokenId = nextId++;
        _mint(to, tokenId);
    }

    function ownerOfAt(uint256 tokenId, uint256 blockNumber) external view returns (address) {
        require(blockNumber < block.number, "FUTURE_BLOCK");
        OwnerCheckpoint[] storage ckpts = _ownerCheckpoints[tokenId];
        uint256 len = ckpts.length;
        if (len == 0) return address(0);
        uint256 low;
        uint256 high = len;
        while (low < high) {
            uint256 mid = (low + high) >> 1;
            if (ckpts[mid].blockNumber <= blockNumber) low = mid + 1;
            else high = mid;
        }
        return low == 0 ? address(0) : ckpts[low - 1].owner;
    }

    function _update(address to, uint256 tokenId, address auth)
        internal
        override
        returns (address from)
    {
        from = super._update(to, tokenId, auth);
        OwnerCheckpoint[] storage ckpts = _ownerCheckpoints[tokenId];
        uint48 currentBlock = uint48(block.number);
        uint256 len = ckpts.length;
        if (len != 0 && ckpts[len - 1].blockNumber == currentBlock) {
            ckpts[len - 1].owner = to;
        } else {
            ckpts.push(OwnerCheckpoint({blockNumber: currentBlock, owner: to}));
        }
    }
}
