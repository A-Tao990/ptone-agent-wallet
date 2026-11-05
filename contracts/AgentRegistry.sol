// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transferFrom(address, address, uint256) external returns (bool);
}

/// PTone Agent Registry (prototype, UNAUDITED, local/testnet only).
/// - owner pays a fixed WIF onboarding fee to open an agent account (fee goes to `feeSink`).
/// - owner sets a policy: per-tx cap, total cap, expiry, recipient allowlist, token.
/// - Funds stay in the OWNER's wallet. Registry never holds principal; it moves tokens ONLY via
///   `execute`, using a finite ERC20 allowance the owner grants to this contract.
/// - `execute` is atomic: policy check + nonce burn + spent update + token.transferFrom(owner,to,amount).
///   If the token transfer fails, the whole call reverts, so spent/nonce are untouched.
/// - Allowlist is versioned: every setPolicy bumps `policyVersion`, so recipients from older policies are invalid.
/// - Caller of `execute` is the owner (user-confirm mode) or the owner-set `executor` (reserved for
///   autonomous mode; contract-level only, no session-key/4337/7702 integration exists yet).
contract AgentRegistry {
    IERC20 public immutable wif;
    uint256 public immutable onboardingFee;
    address public immutable feeSink;

    struct Policy {
        address token; uint128 perTxCap; uint128 totalCap; uint128 spent;
        uint64 expiry; bool active; address executor;
    }
    mapping(address => bool) public registered;
    mapping(address => Policy) public policies;
    mapping(address => uint256) public policyVersion;
    mapping(address => mapping(uint256 => mapping(address => bool))) private _allowed; // owner => version => recipient
    mapping(address => mapping(bytes32 => bool)) public used;    // owner => nonce => used (replay guard)

    event Registered(address indexed owner, uint256 fee);
    event PolicySet(address indexed owner, uint256 version, address token, uint128 perTxCap, uint128 totalCap, uint64 expiry, address executor);
    event RecipientSet(address indexed owner, uint256 version, address indexed to, bool ok);
    event Revoked(address indexed owner);
    event Executed(address indexed owner, bytes32 indexed nonce, address indexed to, address token, uint256 amount, uint128 spentTotal);

    constructor(address wif_, uint256 fee_, address sink_) {
        require(wif_.code.length > 0, "wif code");
        require(sink_ != address(0), "sink");
        wif = IERC20(wif_); onboardingFee = fee_; feeSink = sink_;
    }

    /// SafeERC20-style pull: accepts tokens that return true OR return nothing; rejects false/revert/EOA (no code).
    function _pull(address token, address from, address to, uint256 amount) private {
        require(token.code.length > 0, "token code");
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount));
        require(ok && (ret.length == 0 || (ret.length == 32 && abi.decode(ret, (uint256)) == 1)), "transfer");
    }

    function register() external {
        require(!registered[msg.sender], "registered");
        registered[msg.sender] = true;
        _pull(address(wif), msg.sender, feeSink, onboardingFee);
        emit Registered(msg.sender, onboardingFee);
    }

    /// Replaces policy, resets spent, bumps version (old allowlist becomes invalid), sets new recipients atomically.
    function setPolicy(address token, uint128 perTxCap, uint128 totalCap, uint64 expiry, address executor, address[] calldata recipients) external {
        require(registered[msg.sender], "not registered");
        require(perTxCap > 0 && perTxCap <= totalCap, "caps");
        require(expiry > block.timestamp, "expiry");
        require(token.code.length > 0, "token");
        uint256 v = ++policyVersion[msg.sender];
        Policy storage p = policies[msg.sender];
        p.token = token; p.perTxCap = perTxCap; p.totalCap = totalCap; p.spent = 0;
        p.expiry = expiry; p.active = true; p.executor = executor;
        emit PolicySet(msg.sender, v, token, perTxCap, totalCap, expiry, executor);
        for (uint256 i = 0; i < recipients.length; i++) {
            _allowed[msg.sender][v][recipients[i]] = true;
            emit RecipientSet(msg.sender, v, recipients[i], true);
        }
    }

    /// Edit recipient in the CURRENT policy version only.
    function setRecipient(address to, bool ok) external {
        require(registered[msg.sender], "not registered");
        uint256 v = policyVersion[msg.sender];
        require(v > 0, "no policy");
        _allowed[msg.sender][v][to] = ok; emit RecipientSet(msg.sender, v, to, ok);
    }

    function isAllowed(address owner, address to) public view returns (bool) { return _allowed[owner][policyVersion[owner]][to]; }

    function revoke() external { policies[msg.sender].active = false; emit Revoked(msg.sender); }

    /// Atomic policy-checked transfer: token.transferFrom(owner, to, amount) bound to (owner, token, to, amount, nonce).
    function execute(address owner, bytes32 nonce, address token, address to, uint256 amount) external {
        Policy storage p = policies[owner];
        require(msg.sender == owner || (p.executor != address(0) && msg.sender == p.executor), "caller");
        require(p.active, "inactive");
        require(block.timestamp <= p.expiry, "expired");
        require(token == p.token, "token");
        require(isAllowed(owner, to), "recipient");
        require(amount > 0 && amount <= p.perTxCap, "perTx");
        require(uint256(p.spent) + amount <= p.totalCap, "total");
        require(!used[owner][nonce], "replay");
        used[owner][nonce] = true;
        p.spent += uint128(amount);
        _pull(token, owner, to, amount);
        emit Executed(owner, nonce, to, token, amount, p.spent);
    }
}
