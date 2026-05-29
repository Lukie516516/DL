// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";

interface IDealInfoNFTMetadata {
    function ownerOf(uint256 tokenId) external view returns (address);
    function mediaOf(uint256 tokenId)
        external
        view
        returns (string memory uri, string memory mime, bytes memory data);
    function displayNoOf(uint256 tokenId) external view returns (string memory);
    function seasonOf(uint256 tokenId) external view returns (uint16);
    function dateCodeOf(uint256 tokenId) external view returns (uint32);
    function dailySerialOf(uint256 tokenId) external view returns (uint32);
    function totalMintedOf(uint256 tokenId) external view returns (uint256);
    function lockCount(uint256 tokenId) external view returns (uint32);
}

/// @notice Metadata renderer for DealInfoNFT. Keeps base64/json/svg assembly outside the NFT storage contract.
contract DealInfoNFTRenderer {
    function imageOf(address nft, uint256 tokenId) public view returns (string memory) {
        IDealInfoNFTMetadata meta = IDealInfoNFTMetadata(nft);
        meta.ownerOf(tokenId);
        (string memory uri, string memory mime, bytes memory data) = meta.mediaOf(tokenId);
        if (bytes(uri).length != 0) return uri;
        if (data.length != 0) {
            return string(abi.encodePacked(
                "data:", bytes(mime).length != 0 ? mime : "application/octet-stream",
                ";base64,", Base64.encode(data)
            ));
        }
        string memory svg = string(
            abi.encodePacked(
                "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 350 350'>",
                "<rect fill='#121212' width='100%' height='100%'/>",
                "<text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' font-size='20' fill='#fff'>DINFT #",
                _toString(tokenId), "</text></svg>"
            )
        );
        return string(abi.encodePacked("data:image/svg+xml;base64,", Base64.encode(bytes(svg))));
    }

    function tokenURI(address nft, uint256 tokenId) external view returns (string memory) {
        IDealInfoNFTMetadata meta = IDealInfoNFTMetadata(nft);
        meta.ownerOf(tokenId);
        string memory displayNo = meta.displayNoOf(tokenId);
        bytes memory json = abi.encodePacked(
            '{',
                '"name":"Deal Info NFT ', displayNo, '",',
                '"description":"Deal Info NFT - partner & DC stats",',
                '"image":"', imageOf(nft, tokenId), '",',
                '"attributes":[',
                    '{"trait_type":"Display No","value":"', displayNo, '"},',
                    '{"trait_type":"Season","value":"', _toString(meta.seasonOf(tokenId)), '"},',
                    '{"trait_type":"Date Code","value":"', _toString(meta.dateCodeOf(tokenId)), '"},',
                    '{"trait_type":"Daily Serial","value":"', _toString(meta.dailySerialOf(tokenId)), '"},',
                    '{"trait_type":"Total DC Minted","value":"', _toString(meta.totalMintedOf(tokenId)), '"},',
                    '{"trait_type":"Locked","value":"', meta.lockCount(tokenId) > 0 ? "true" : "false", '"}',
                ']',
            '}'
        );
        return string(abi.encodePacked("data:application/json;base64,", Base64.encode(json)));
    }

    function _toString(uint256 v) internal pure returns (string memory str) {
        if (v == 0) return "0";
        uint256 j = v;
        uint256 len;
        while (j != 0) {
            len++;
            j /= 10;
        }
        bytes memory b = new bytes(len);
        while (v != 0) {
            len -= 1;
            b[len] = bytes1(uint8(48 + v % 10));
            v /= 10;
        }
        str = string(b);
    }
}
