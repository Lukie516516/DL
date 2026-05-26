// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Minimal WETH-style wrapper for the AGI native coin.
contract WrappedAGI {
    string public constant name = "Wrapped AGI";
    string public constant symbol = "WAGI";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Deposit(address indexed dst, uint256 wad);
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Withdrawal(address indexed src, uint256 wad);

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        require(msg.value > 0, "ZERO_VALUE");
        balanceOf[msg.sender] += msg.value;
        totalSupply += msg.value;
        emit Deposit(msg.sender, msg.value);
        emit Transfer(address(0), msg.sender, msg.value);
    }

    function withdraw(uint256 wad) external {
        require(balanceOf[msg.sender] >= wad, "BALANCE");
        balanceOf[msg.sender] -= wad;
        totalSupply -= wad;
        emit Withdrawal(msg.sender, wad);
        emit Transfer(msg.sender, address(0), wad);
        (bool ok,) = msg.sender.call{value: wad}("");
        require(ok, "NATIVE_SEND_FAIL");
    }

    function approve(address guy, uint256 wad) external returns (bool) {
        allowance[msg.sender][guy] = wad;
        emit Approval(msg.sender, guy, wad);
        return true;
    }

    function transfer(address dst, uint256 wad) external returns (bool) {
        return transferFrom(msg.sender, dst, wad);
    }

    function transferFrom(address src, address dst, uint256 wad) public returns (bool) {
        require(balanceOf[src] >= wad, "BALANCE");

        if (src != msg.sender && allowance[src][msg.sender] != type(uint256).max) {
            uint256 allowed = allowance[src][msg.sender];
            require(allowed >= wad, "ALLOWANCE");
            allowance[src][msg.sender] = allowed - wad;
            emit Approval(src, msg.sender, allowance[src][msg.sender]);
        }

        balanceOf[src] -= wad;
        balanceOf[dst] += wad;
        emit Transfer(src, dst, wad);
        return true;
    }
}
