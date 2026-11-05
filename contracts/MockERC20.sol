// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
/// LOCAL TEST ONLY. Stand-in for WIF in tests. Never deploy publicly.
contract MockERC20 {
    string public name; string public symbol; uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 v);
    event Approval(address indexed o, address indexed s, uint256 v);
    constructor(string memory n, string memory s, uint8 d) { name = n; symbol = s; decimals = d; }
    function mint(address to, uint256 v) external { balanceOf[to] += v; totalSupply += v; emit Transfer(address(0), to, v); }
    function approve(address s, uint256 v) external returns (bool) { allowance[msg.sender][s] = v; emit Approval(msg.sender, s, v); return true; }
    function transfer(address to, uint256 v) external returns (bool) { _t(msg.sender, to, v); return true; }
    function transferFrom(address f, address to, uint256 v) external virtual returns (bool) {
        uint256 a = allowance[f][msg.sender];
        if (a != type(uint256).max) { require(a >= v, "allowance"); allowance[f][msg.sender] = a - v; }
        _t(f, to, v); return true;
    }
    function _t(address f, address to, uint256 v) internal { require(balanceOf[f] >= v, "balance"); balanceOf[f] -= v; balanceOf[to] += v; emit Transfer(f, to, v); }
}

/// LOCAL TEST ONLY. transferFrom returns false (no revert) / returns nothing, to test SafeERC20-style handling.
contract MockFalseToken is MockERC20 {
    constructor() MockERC20("False", "FALSE", 18) {}
    function transferFrom(address, address, uint256) external pure override returns (bool) { return false; }
}
contract MockNoReturnToken {
    mapping(address => uint256) public balanceOf; mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 v) external { balanceOf[to] += v; }
    function approve(address s, uint256 v) external { allowance[msg.sender][s] = v; } // USDT-style: no return value
    function transferFrom(address f, address to, uint256 v) external { // no return value
        require(allowance[f][msg.sender] >= v && balanceOf[f] >= v, "x");
        allowance[f][msg.sender] -= v; balanceOf[f] -= v; balanceOf[to] += v;
    }
    function decimals() external pure returns (uint8) { return 6; }
}
