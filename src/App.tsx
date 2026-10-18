import React, { useState, useEffect, useMemo, useCallback } from "react";
import {
  Wallet,
  JsonRpcProvider,
  Contract,
  Interface,
  formatUnits,
  parseUnits,
  formatEther,
  isAddress,
  getAddress,
  Network,
  ethers,
} from "ethers";

import {
  AlertCircle,
  Loader2,
  CheckCircle,
  Send,
  Wallet as LucideWallet,
  ExternalLink,
  Rocket,
  RefreshCw,
  Copy,
  Check,
} from "lucide-react";
import type { FetchRequest } from "ethers";
import { SUPPORTED_CHAINS, type SupportedChain } from "./chains";

// Modular Account V2 contracts (same address on every supported chain)
const FACTORY_ADDRESS = "0x00000000000017c61b5bEe81050EC8eFc9c6fecd";
const SEMI_MODULAR_ACCOUNT_IMPL = "0x000000000000c5A9089039570Dd36455b5C07383";
const ACCOUNT_SALT = 0n;

const DEFAULT_CHAIN_ID = 137;
const CUSTOM_RPC = "__custom__";
const NATIVE_ASSET = "native";
const CUSTOM_TOKEN = "custom";

const FACTORY_ABI = [
  "function createSemiModularAccount(address owner, uint256 salt) returns (address)",
  "function getAddressSemiModular(address owner, uint256 salt) view returns (address)",
];

const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

// The owner (fallback signer) can call execute directly, so no bundler is needed.
const SMART_WALLET_ABI = [
  "function execute(address target, uint256 value, bytes data) payable returns (bytes)",
];

// Safety margins applied on top of the node's estimates
const GAS_LIMIT_MARGIN_PCT = 120n;
const FEE_MARGIN_PCT = 150n;

// Rough gas usage, used to suggest how much native token to send to the
// signer. Doubled to cover L1 data fees on rollups and price swings.
const DEPLOY_GAS_UNITS = 150_000n;
const TRANSFER_GAS_UNITS = 120_000n;
const SUGGESTED_GAS_MARGIN_PCT = 200n;

type DefaultError = {
  code?: string;
  shortMessage?: string;
  message: string;
};

interface TokenInfo {
  address: string;
  symbol: string;
  decimals: number;
}

interface AccountState {
  smartWalletAddress: string;
  defaultAddress: string;
  deployed: boolean;
  eoaBalance: bigint;
  smartWalletBalance: bigint;
  token: (TokenInfo & { balance: bigint }) | null;
  // Native amount the signer should hold to deploy (if needed) and transfer
  suggestedGas: bigint;
}

// Rate limiting configuration
const RATE_LIMIT_CONFIG = {
  slotInterval: 1000, // Wait 1 second between requests
  maxAttempts: 3, // Retry up to 3 times on failure
};

// Cache providers to reuse throttled instances
const providerCache = new Map<string, JsonRpcProvider>();

const buildFetchRequest = (url: string): FetchRequest => {
  const req = new ethers.FetchRequest(url);
  // Configure throttling to limit request rate
  req.setThrottleParams({
    maxAttempts: RATE_LIMIT_CONFIG.maxAttempts,
    slotInterval: RATE_LIMIT_CONFIG.slotInterval,
  });
  return req;
};

const getProvider = (url: string, chainId: number): JsonRpcProvider => {
  const key = `${chainId}:${url}`;
  const cached = providerCache.get(key);
  if (cached) return cached;

  const network = Network.from(chainId);
  const provider = new JsonRpcProvider(buildFetchRequest(url), network, {
    batchMaxCount: 1, // Disable batching to avoid rate limits
    staticNetwork: network,
    polling: false,
  });
  providerCache.set(key, provider);
  return provider;
};

const hasCode = async (provider: JsonRpcProvider, address: string) =>
  (await provider.getCode(address)) !== "0x";

const shorten = (address: string) =>
  `${address.slice(0, 6)}...${address.slice(-4)}`;

const describeError = (err: unknown): string => {
  const error = err as DefaultError;
  if (error.code === "CALL_EXCEPTION") {
    return "Smart wallet execution reverted. Make sure the signer is the owner of this smart wallet.";
  }
  if (error.code === "INSUFFICIENT_FUNDS") {
    return "Insufficient funds for gas fees.";
  }
  return error.shortMessage || error.message || String(err);
};

// A single word is a private key, several words a mnemonic
const walletFromSecret = (secret: string): Wallet => {
  const words = secret.trim().split(/\s+/);
  if (words.length > 1) {
    return Wallet.fromPhrase(words.join(" ")) as unknown as Wallet;
  }
  const key = words[0].startsWith("0x") ? words[0] : `0x${words[0]}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(
      "this is not a valid private key (64 hex characters) or mnemonic phrase"
    );
  }
  return new Wallet(key);
};

const sortedChains = (showTestnets: boolean) =>
  SUPPORTED_CHAINS.filter((c) => showTestnets || !c.testnet);

type StepStatus = "done" | "current" | "pending";

// One numbered step of the recovery flow: explanation on top, controls below
const Step: React.FC<{
  number: number;
  status: StepStatus;
  title: string;
  description: React.ReactNode;
  children?: React.ReactNode;
}> = ({ number, status, title, description, children }) => (
  <section className="flex gap-3">
    <span
      className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold ${
        status === "done"
          ? "bg-green-600 text-white"
          : status === "current"
            ? "bg-purple-600 text-white"
            : "bg-gray-200 text-gray-600"
      }`}
    >
      {status === "done" ? <Check className="w-4 h-4" /> : number}
    </span>
    <div className="flex-1 min-w-0 space-y-4">
      <div>
        <h2
          className={`text-base font-semibold ${
            status === "pending" ? "text-gray-500" : "text-gray-900"
          }`}
        >
          {title}
        </h2>
        <p className="text-xs text-gray-600 mt-1">{description}</p>
      </div>
      {children}
    </div>
  </section>
);

const ModularAccountApp: React.FC = () => {
  const [showTestnets, setShowTestnets] = useState(false);
  const [chainId, setChainId] = useState<number>(DEFAULT_CHAIN_ID);
  const [selectedRpc, setSelectedRpc] = useState<string>("");
  const [customRpc, setCustomRpc] = useState("");

  const [secret, setSecret] = useState("");
  const [addressOverride, setAddressOverride] = useState("");
  const [signer, setSigner] = useState<Wallet | null>(null);
  const [account, setAccount] = useState<AccountState | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const [asset, setAsset] = useState<string>(NATIVE_ASSET);
  const [tokenAddress, setTokenAddress] = useState("");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");

  const [loading, setLoading] = useState(false);
  const [loadingAccount, setLoadingAccount] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [txHash, setTxHash] = useState("");
  const [estimatedGas, setEstimatedGas] = useState<string | null>(null);
  // Step whose action produced the current error / success message
  const [messageStep, setMessageStep] = useState(2);

  const chain: SupportedChain = useMemo(
    () =>
      SUPPORTED_CHAINS.find((c) => c.chainId === chainId) ??
      SUPPORTED_CHAINS[0],
    [chainId],
  );
  const rpcUrl = selectedRpc === CUSTOM_RPC ? customRpc.trim() : selectedRpc;
  const nativeSymbol = chain.nativeSymbol;
  // asset is NATIVE_ASSET, CUSTOM_TOKEN or the address of a known token
  const erc20Address =
    asset === NATIVE_ASSET
      ? null
      : asset === CUSTOM_TOKEN
        ? tokenAddress.trim() || null
        : asset;

  // Reset the RPC selection whenever the chain changes
  useEffect(() => {
    setSelectedRpc(chain.rpcs[0] ?? CUSTOM_RPC);
    setAccount(null);
    setAsset(NATIVE_ASSET);
    setTxHash("");
    setSuccess("");
    setEstimatedGas(null);
  }, [chain]);

  // Load smart wallet address, deployment status and balances for the
  // current chain / RPC / token. Re-runs whenever any of them changes.
  useEffect(() => {
    if (!signer || !rpcUrl) return;
    let cancelled = false;

    const load = async () => {
      setLoadingAccount(true);
      setError("");
      try {
        const provider = getProvider(rpcUrl, chain.chainId);
        const [factoryDeployed, implDeployed] = await Promise.all([
          hasCode(provider, FACTORY_ADDRESS),
          hasCode(provider, SEMI_MODULAR_ACCOUNT_IMPL),
        ]);
        if (!factoryDeployed || !implDeployed) {
          throw new Error(
            `Modular Account V2 contracts are not deployed on ${chain.name}.`,
          );
        }

        const factory = new Contract(FACTORY_ADDRESS, FACTORY_ABI, provider);
        const defaultAddress: string = await factory.getAddressSemiModular(
          signer.address,
          ACCOUNT_SALT,
        );
        const smartWalletAddress = addressOverride.trim()
          ? getAddress(addressOverride.trim())
          : defaultAddress;

        const [deployed, eoaBalance, smartWalletBalance, feeData] =
          await Promise.all([
            hasCode(provider, smartWalletAddress),
            provider.getBalance(signer.address),
            provider.getBalance(smartWalletAddress),
            provider.getFeeData(),
          ]);
        const gasUnits =
          (deployed ? 0n : DEPLOY_GAS_UNITS) + TRANSFER_GAS_UNITS;
        const suggestedGas =
          (gasUnits *
            (feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n) *
            SUGGESTED_GAS_MARGIN_PCT) /
          100n;

        let token: AccountState["token"] = null;
        if (erc20Address && isAddress(erc20Address)) {
          const erc20 = new Contract(erc20Address, ERC20_ABI, provider);
          const [symbol, decimals, balance] = await Promise.all([
            erc20.symbol(),
            erc20.decimals(),
            erc20.balanceOf(smartWalletAddress),
          ]);
          token = {
            address: getAddress(erc20Address),
            symbol,
            decimals: Number(decimals),
            balance,
          };
        }

        if (cancelled) return;
        setAccount({
          smartWalletAddress,
          defaultAddress,
          deployed,
          eoaBalance,
          smartWalletBalance,
          token,
          suggestedGas,
        });
      } catch (err) {
        if (cancelled) return;
        setAccount(null);
        setMessageStep(2);
        setError("Failed to load wallet: " + describeError(err));
      } finally {
        if (!cancelled) setLoadingAccount(false);
      }
    };

    // Debounce so typing a custom RPC or token address doesn't spam requests
    const timeout = setTimeout(load, 400);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [signer, rpcUrl, chain, addressOverride, erc20Address, refreshNonce]);

  const refresh = useCallback(() => setRefreshNonce((n) => n + 1), []);

  const handleImportWallet = (): void => {
    setMessageStep(2);
    setError("");
    setSuccess("");
    if (!secret.trim()) {
      setError("Please enter your private key or mnemonic phrase");
      return;
    }
    if (addressOverride.trim() && !isAddress(addressOverride.trim())) {
      setError("Please enter a valid smart wallet address or leave it empty");
      return;
    }
    if (!rpcUrl) {
      setError("Please select or enter an RPC endpoint");
      return;
    }
    try {
      setSigner(walletFromSecret(secret));
    } catch (err) {
      setError("Failed to import wallet: " + describeError(err));
    }
  };

  const handleDisconnect = (): void => {
    setSigner(null);
    setAccount(null);
    setError("");
    setSuccess("");
    setTxHash("");
    setEstimatedGas(null);
  };

  // Sends a transaction from the signer EOA after checking it can cover gas
  const sendFromSigner = async (
    to: string,
    data: string,
    description: string,
  ): Promise<void> => {
    if (!signer || !account) return;
    const provider = getProvider(rpcUrl, chain.chainId);
    const connected = signer.connect(provider);

    const [gasEstimate, feeData] = await Promise.all([
      provider.estimateGas({ from: signer.address, to, data }),
      provider.getFeeData(),
    ]);
    const gasLimit = (gasEstimate * GAS_LIMIT_MARGIN_PCT) / 100n;
    const maxFeePerGas =
      ((feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n) * FEE_MARGIN_PCT) /
      100n;
    const estimatedCost = gasLimit * maxFeePerGas;
    setEstimatedGas(formatEther(estimatedCost));

    if (account.eoaBalance < estimatedCost) {
      throw new Error(
        `Insufficient ${nativeSymbol} for gas fees. Signer has ${formatEther(
          account.eoaBalance,
        )} ${nativeSymbol} but needs approximately ${formatEther(
          estimatedCost,
        )} ${nativeSymbol}.`,
      );
    }

    const tx = await connected.sendTransaction({ to, data, gasLimit });
    console.log(`${description} sent:`, tx.hash);
    setTxHash(tx.hash);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error(`${description} reverted (tx ${tx.hash})`);
    }
  };

  const handleDeploy = async (): Promise<void> => {
    if (!signer || !account) return;
    setMessageStep(4);
    setError("");
    setSuccess("");
    setTxHash("");
    setEstimatedGas(null);
    setLoading(true);
    try {
      const data = new Interface(FACTORY_ABI).encodeFunctionData(
        "createSemiModularAccount",
        [signer.address, ACCOUNT_SALT],
      );
      await sendFromSigner(FACTORY_ADDRESS, data, "Deploy");
      setSuccess(`Smart wallet deployed on ${chain.name}!`);
      refresh();
    } catch (err) {
      console.error("Deploy error:", err);
      setError("Deploy failed: " + describeError(err));
    } finally {
      setLoading(false);
    }
  };

  const handleSend = async (): Promise<void> => {
    setMessageStep(5);
    if (!signer || !account) {
      setError("Please import your wallet first");
      return;
    }
    if (!isAddress(recipient.trim())) {
      setError("Please enter a valid recipient address");
      return;
    }
    if (!amount || parseFloat(amount) <= 0) {
      setError("Please enter a valid amount");
      return;
    }
    if (asset !== NATIVE_ASSET && !account.token) {
      setError("Please enter a valid ERC20 token address");
      return;
    }

    setError("");
    setSuccess("");
    setTxHash("");
    setEstimatedGas(null);
    setLoading(true);

    try {
      const to = getAddress(recipient.trim());
      const token = asset === NATIVE_ASSET ? null : account.token!;
      const symbol = token?.symbol ?? nativeSymbol;
      const value = parseUnits(amount, token?.decimals ?? 18);
      const available = token?.balance ?? account.smartWalletBalance;
      if (value > available) {
        throw new Error(`Insufficient ${symbol} balance in the smart wallet`);
      }

      // Native transfers send value directly; ERC20 transfers call the token
      const [target, callValue, callData] = token
        ? [
            token.address,
            0n,
            new Interface(ERC20_ABI).encodeFunctionData("transfer", [
              to,
              value,
            ]),
          ]
        : [to, value, "0x"];

      const data = new Interface(SMART_WALLET_ABI).encodeFunctionData(
        "execute",
        [target, callValue, callData],
      );

      await sendFromSigner(account.smartWalletAddress, data, "Transfer");
      setSuccess(
        `Transaction successful! ${amount} ${symbol} sent to ${shorten(to)}`,
      );
      setAmount("");
      setRecipient("");
      refresh();
    } catch (err) {
      console.error("Transaction error:", err);
      setError("Transaction failed: " + describeError(err));
    } finally {
      setLoading(false);
    }
  };

  const explorerTxUrl =
    chain.explorer && txHash ? `${chain.explorer}/tx/${txHash}` : null;
  const explorerAddressUrl = (address: string) =>
    chain.explorer ? `${chain.explorer}/address/${address}` : null;

  const canDeploy =
    account &&
    !account.deployed &&
    account.smartWalletAddress === account.defaultAddress;

  const [copied, setCopied] = useState(false);
  const copySignerAddress = async () => {
    if (!signer) return;
    await navigator.clipboard.writeText(signer.address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // Each step is done, the current one (first not done) or still pending
  const hasGas = !!account && account.eoaBalance >= account.suggestedGas;
  const stepsDone = [
    !!signer,
    !!account,
    hasGas,
    !!account?.deployed,
    false,
  ];
  const currentStep = stepsDone.findIndex((done) => !done);
  const stepStatus = (index: number): StepStatus =>
    stepsDone[index] ? "done" : index === currentStep ? "current" : "pending";

  const inputClass =
    "w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent transition-all bg-white";
  const primaryButtonClass =
    "w-full py-3 px-4 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white font-medium rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg";

  const renderAddress = (address: string) => {
    const url = explorerAddressUrl(address);
    return url ? (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sm font-mono text-gray-800 break-all hover:text-purple-600"
      >
        {address}
      </a>
    ) : (
      <p className="text-sm font-mono text-gray-800 break-all">{address}</p>
    );
  };

  // Error / success feedback, shown under the step that triggered it
  const renderMessages = (step: number) =>
    messageStep !== step ? null : (
      <>
        {error && (
          <div className="p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-800 break-words min-w-0">{error}</p>
          </div>
        )}
        {estimatedGas && (
          <p className="text-xs text-gray-600">
            Estimated gas fee:{" "}
            <span className="font-semibold text-gray-800">
              ~{parseFloat(estimatedGas).toFixed(6)} {nativeSymbol}
            </span>
          </p>
        )}
        {(success || (loading && txHash)) && (
          <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
            {success && (
              <div className="flex items-start gap-3 mb-2">
                <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-green-800">{success}</p>
              </div>
            )}
            {loading && txHash && (
              <p className="text-sm text-green-800">
                Waiting for confirmation...
              </p>
            )}
            {explorerTxUrl && (
              <a
                href={explorerTxUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-sm text-purple-600 hover:text-purple-700 font-medium mt-2"
              >
                View on explorer
                <ExternalLink className="w-4 h-4" />
              </a>
            )}
          </div>
        )}
      </>
    );

  const refreshButton = (
    <button
      onClick={refresh}
      disabled={loading || loadingAccount}
      title="Refresh balances"
      className="p-1 text-purple-600 hover:text-purple-800 disabled:opacity-50"
    >
      <RefreshCw
        className={`w-4 h-4 ${loadingAccount ? "animate-spin" : ""}`}
      />
    </button>
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-900 via-purple-800 to-indigo-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-2xl shadow-2xl p-8">
          <div className="text-center mb-8">
            <div className="inline-block p-3 bg-purple-100 rounded-full mb-4">
              <Send className="w-8 h-8 text-purple-600" />
            </div>
            <h1 className="text-3xl font-bold text-gray-800 mb-2">
              Modular Account V2
            </h1>
            <p className="text-gray-600">
              Recover the tokens in your smart wallet, step by step
            </p>
          </div>

          <div className="space-y-8">
            <Step
              number={1}
              status={stepStatus(0)}
              title="Choose the network"
              description="Select the network where your tokens are. Your smart wallet has the same address on every network, but each network must be recovered separately."
            >
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-sm font-medium text-gray-700">
                    Network
                  </label>
                  <label className="flex items-center gap-2 text-xs text-gray-600">
                    <input
                      type="checkbox"
                      checked={showTestnets}
                      onChange={(e) => setShowTestnets(e.target.checked)}
                      disabled={loading}
                    />
                    Show testnets
                  </label>
                </div>
                <select
                  value={chain.chainId}
                  onChange={(e) => setChainId(Number(e.target.value))}
                  className={inputClass}
                  disabled={loading}
                >
                  {sortedChains(showTestnets || chain.testnet).map((c) => (
                    <option key={c.chainId} value={c.chainId}>
                      {c.name} ({c.chainId})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  RPC Endpoint
                </label>
                <select
                  value={selectedRpc}
                  onChange={(e) => setSelectedRpc(e.target.value)}
                  className={inputClass}
                  disabled={loading}
                >
                  {chain.rpcs.map((url) => (
                    <option key={url} value={url}>
                      {url}
                    </option>
                  ))}
                  <option value={CUSTOM_RPC}>Custom RPC...</option>
                </select>
                {selectedRpc === CUSTOM_RPC && (
                  <input
                    type="text"
                    value={customRpc}
                    onChange={(e) => setCustomRpc(e.target.value)}
                    placeholder="https://..."
                    className={`${inputClass} mt-2`}
                    disabled={loading}
                  />
                )}
              </div>
            </Step>

            <Step
              number={2}
              status={stepStatus(1)}
              title="Import your wallet"
              description={
                <>
                  Paste your private key or your
                  mnemonic phrase. The app then shows your{" "}
                  <strong>Smart Wallet</strong>, which holds your tokens, and
                  your <strong>Signer Wallet</strong>, which controls it and
                  pays the network fees.
                </>
              }
            >
              {!signer ? (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Private Key or Mnemonic Phrase
                    </label>
                    <textarea
                      value={secret}
                      onChange={(e) => setSecret(e.target.value)}
                      placeholder="0x… private key, or your 12 or 24 word mnemonic phrase"
                      autoComplete="off"
                      spellCheck={false}
                      className={`${inputClass} resize-none`}
                      rows={3}
                      disabled={loading}
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Smart Wallet Address{" "}
                      <span className="font-normal text-gray-500">
                        (optional)
                      </span>
                    </label>
                    <input
                      type="text"
                      value={addressOverride}
                      onChange={(e) => setAddressOverride(e.target.value)}
                      placeholder="Leave empty to use the default for this signer"
                      className={inputClass}
                      disabled={loading}
                    />
                  </div>

                  {renderMessages(2)}

                  <button
                    onClick={handleImportWallet}
                    disabled={loading}
                    className="w-full py-3 px-4 bg-purple-600 hover:bg-purple-700 text-white font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    <LucideWallet className="w-5 h-5" />
                    Import Wallet
                  </button>
                </>
              ) : (
                <>
                  <div className="p-4 bg-purple-50 rounded-lg border border-purple-200 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-xs text-gray-600 mb-1">
                          Smart Wallet (holds your tokens)
                        </p>
                        {account ? (
                          renderAddress(account.smartWalletAddress)
                        ) : (
                          <Loader2 className="w-4 h-4 animate-spin text-purple-600" />
                        )}
                      </div>
                      {refreshButton}
                    </div>

                    {account && (
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <p className="text-xs text-gray-600 mb-1">
                            Balance
                          </p>
                          <p className="text-xl font-bold text-purple-600 break-all">
                            {formatEther(account.smartWalletBalance)}
                          </p>
                          <p className="text-xs text-gray-500">
                            {nativeSymbol}
                          </p>
                        </div>
                        {account.token && (
                          <div>
                            <p className="text-xs text-gray-600 mb-1">
                              Token Balance
                            </p>
                            <p className="text-xl font-bold text-purple-600 break-all">
                              {formatUnits(
                                account.token.balance,
                                account.token.decimals,
                              )}
                            </p>
                            <p className="text-xs text-gray-500">
                              {account.token.symbol}
                            </p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {renderMessages(2)}

                  <button
                    onClick={handleDisconnect}
                    disabled={loading}
                    className="text-xs text-gray-500 hover:text-gray-800 disabled:opacity-50"
                  >
                    Use a different wallet
                  </button>
                </>
              )}
            </Step>

            <Step
              number={3}
              status={stepStatus(2)}
              title={`Add ${nativeSymbol} for gas to the Signer Wallet`}
              description={
                <>
                  Network fees are always paid by the Signer Wallet. Do{" "}
                  <strong>not</strong> send {nativeSymbol} to the Smart Wallet
                  for gas. Anything left over stays in the Signer Wallet and can
                  be withdrawn by importing the same private key or mnemonic in
                  a regular wallet.
                </>
              }
            >
              {account && signer && (
                <div className="p-4 bg-purple-50 rounded-lg border border-purple-200 space-y-3">
                  <p className="text-sm text-gray-800">
                    Send about{" "}
                    <strong>
                      {Number(formatEther(account.suggestedGas)).toPrecision(2)}{" "}
                      {nativeSymbol}
                    </strong>{" "}
                    on <strong>{chain.name}</strong> to:
                  </p>
                  <div className="flex items-center gap-2 rounded-md bg-white border border-gray-200 px-3 py-2">
                    <span className="font-mono text-xs text-gray-800 break-all">
                      {signer.address}
                    </span>
                    <button
                      onClick={copySignerAddress}
                      title="Copy address"
                      className="p-1 text-purple-600 hover:text-purple-800 flex-shrink-0"
                    >
                      {copied ? (
                        <Check className="w-4 h-4" />
                      ) : (
                        <Copy className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                  <div className="flex items-end justify-between gap-2">
                    <div>
                      <p className="text-xs text-gray-600 mb-1">
                        Signer Wallet balance
                      </p>
                      <p className="text-xl font-bold text-indigo-600 break-all">
                        {formatEther(account.eoaBalance)}{" "}
                        <span className="text-xs font-normal text-gray-500">
                          {nativeSymbol}
                        </span>
                      </p>
                    </div>
                    {refreshButton}
                  </div>
                  {!hasGas && (
                    <p className="text-xs text-gray-600">
                      After sending, click refresh to update the balance.
                    </p>
                  )}
                </div>
              )}
            </Step>

            <Step
              number={4}
              status={stepStatus(3)}
              title="Deploy the Smart Wallet (if needed)"
              description="Needed once per network, paid by the Signer Wallet. Your tokens are safe at the Smart Wallet address before and after deploying."
            >
              {account &&
                (account.deployed ? (
                  <p className="text-sm text-green-700">
                    Your Smart Wallet is already deployed on {chain.name}.
                  </p>
                ) : canDeploy ? (
                  <>
                    {renderMessages(4)}
                    <button
                      onClick={handleDeploy}
                      disabled={loading || loadingAccount}
                      className={primaryButtonClass}
                    >
                      {loading ? (
                        <>
                          <Loader2 className="w-5 h-5 animate-spin" />
                          Deploying...
                        </>
                      ) : (
                        <>
                          <Rocket className="w-5 h-5" />
                          Deploy Smart Wallet
                        </>
                      )}
                    </button>
                  </>
                ) : (
                  <p className="text-sm text-red-700">
                    This address is not the default smart wallet for this
                    signer, so it can't be deployed from here.
                  </p>
                ))}
              {account?.deployed && renderMessages(4)}
            </Step>

            <Step
              number={5}
              status={account?.deployed ? "current" : "pending"}
              title="Send your tokens"
              description={`Choose the asset and where to send it, for example your exchange deposit address or another wallet you control. Make sure the recipient supports ${chain.name}. Repeat for each token and network.`}
            >
              {account?.deployed && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Asset
                    </label>
                    <select
                      value={asset}
                      onChange={(e) => setAsset(e.target.value)}
                      className={inputClass}
                      disabled={loading}
                    >
                      <option value={NATIVE_ASSET}>
                        {nativeSymbol} (native)
                      </option>
                      {chain.tokens.map((token) => (
                        <option key={token.address} value={token.address}>
                          {token.symbol} ({token.name})
                        </option>
                      ))}
                      <option value={CUSTOM_TOKEN}>Custom ERC20...</option>
                    </select>
                    {asset === CUSTOM_TOKEN && (
                      <input
                        type="text"
                        value={tokenAddress}
                        onChange={(e) => setTokenAddress(e.target.value)}
                        placeholder="Token contract address 0x..."
                        className={`${inputClass} mt-2`}
                        disabled={loading}
                      />
                    )}
                    <p className="text-xs text-gray-600 mt-1">
                      Available:{" "}
                      <strong>
                        {asset === NATIVE_ASSET
                          ? `${formatEther(account.smartWalletBalance)} ${nativeSymbol}`
                          : account.token
                            ? `${formatUnits(account.token.balance, account.token.decimals)} ${account.token.symbol}`
                            : "-"}
                      </strong>
                    </p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Recipient Address
                    </label>
                    <input
                      type="text"
                      value={recipient}
                      onChange={(e) => setRecipient(e.target.value)}
                      placeholder="0x..."
                      className={inputClass}
                      disabled={loading}
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Amount (
                      {asset === NATIVE_ASSET
                        ? nativeSymbol
                        : (account.token?.symbol ?? "token")}
                      )
                    </label>
                    <div className="relative">
                      <input
                        type="number"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        placeholder="0.00"
                        step="any"
                        min="0"
                        className={`${inputClass} pr-20 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`}
                        disabled={loading}
                      />
                      {/* Gas is paid by the signer, so the whole balance can be sent */}
                      <button
                        type="button"
                        onClick={() => {
                          if (asset === NATIVE_ASSET) {
                            setAmount(formatEther(account.smartWalletBalance));
                          } else if (account.token) {
                            setAmount(
                              formatUnits(
                                account.token.balance,
                                account.token.decimals,
                              ),
                            );
                          }
                        }}
                        disabled={
                          loading || (asset !== NATIVE_ASSET && !account.token)
                        }
                        className="absolute right-3 top-1/2 -translate-y-1/2 px-2 py-1 text-xs font-semibold text-purple-700 bg-purple-100 hover:bg-purple-200 rounded-md disabled:opacity-50"
                      >
                        MAX
                      </button>
                    </div>
                  </div>

                  {renderMessages(5)}

                  <button
                    onClick={handleSend}
                    disabled={loading || loadingAccount}
                    className={primaryButtonClass}
                  >
                    {loading ? (
                      <>
                        <Loader2 className="w-5 h-5 animate-spin" />
                        Sending...
                      </>
                    ) : (
                      <>
                        <Send className="w-5 h-5" />
                        Send
                      </>
                    )}
                  </button>
                </>
              )}
            </Step>
          </div>

          <div className="mt-8 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
            <p className="text-xs text-yellow-800">
              <strong>⚠️ Security Warning:</strong> Never share your private
              key or mnemonic phrase with anyone. This app runs entirely in your browser and
              sends transactions directly from your signer wallet through the
              selected RPC — no bundler or backend is involved.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ModularAccountApp;
