// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title MirrorParams
/// @notice 部署在目标链。镜像主网 DealGovernance 的参数，
///         由 LZGovernanceExecutor 跨链调用写入。
///
/// 生产环境中此合约会被替换为真实业务合约（DealFactory 等）。
contract MirrorParams {
    address public executor;

    uint256 public activationThreshold;
    uint256 public fastPassThreshold;
    uint256 public treasuryPassThreshold;
    uint256 public satoshiPassThreshold;
    uint256 public paramWindowSeconds;
    uint256 public majorWindowSeconds;

    event ParamUpdated(string indexed name, uint256 oldValue, uint256 newValue);
    event ExecutorUpdated(address indexed oldExecutor, address indexed newExecutor);

    error NotExecutor();
    error ZeroAddress();

    modifier onlyExecutor() {
        if (msg.sender != executor) revert NotExecutor();
        _;
    }

    constructor(address executor_) {
        if (executor_ == address(0)) revert ZeroAddress();
        executor = executor_;
    }

    function setExecutor(address e) external onlyExecutor {
        // FIX CRITICAL-2: address(0) 会永久锁死所有 onlyExecutor 函数，无恢复路径
        if (e == address(0)) revert ZeroAddress();
        // FIX LOW-5: 先更新状态，再发事件（符合 CEI 模式）
        address old = executor;
        executor = e;
        emit ExecutorUpdated(old, e);
    }

    function setActivationThreshold(uint256 v) external onlyExecutor {
        emit ParamUpdated("activationThreshold", activationThreshold, v);
        activationThreshold = v;
    }

    function setFastPassThreshold(uint256 v) external onlyExecutor {
        emit ParamUpdated("fastPassThreshold", fastPassThreshold, v);
        fastPassThreshold = v;
    }

    function setTreasuryPassThreshold(uint256 v) external onlyExecutor {
        emit ParamUpdated("treasuryPassThreshold", treasuryPassThreshold, v);
        treasuryPassThreshold = v;
    }

    function setSatoshiPassThreshold(uint256 v) external onlyExecutor {
        emit ParamUpdated("satoshiPassThreshold", satoshiPassThreshold, v);
        satoshiPassThreshold = v;
    }

    function setParamWindowSeconds(uint256 v) external onlyExecutor {
        emit ParamUpdated("paramWindowSeconds", paramWindowSeconds, v);
        paramWindowSeconds = v;
    }

    function setMajorWindowSeconds(uint256 v) external onlyExecutor {
        emit ParamUpdated("majorWindowSeconds", majorWindowSeconds, v);
        majorWindowSeconds = v;
    }
}
