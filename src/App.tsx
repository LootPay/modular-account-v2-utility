import React, { useState, useEffect, useRef } from "react";
import {
  Wallet,
  JsonRpcProvider,
  Contract,
  Interface,
  formatUnits,
  parseUnits,
  formatEther,
  parseEther,
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
} from "lucide-react";
import type { FetchRequest, JsonRpcApiProviderOptions } from "ethers";

const USDT_POLYGON_ADDRESS = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";

// Default RPC (fallback)
const DEFAULT_RPC = "https://polygon-rpc.com";

interface RpcOption {
  name: string;
  url: string;
}

const USDT_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

// Smart Wallet ABI - métodos comuns de Account Abstraction
const SMART_WALLET_ABI = [
  "function execute(address dest, uint256 value, bytes calldata func) external",
  "function executeBatch(address[] calldata dest, uint256[] calldata value, bytes[] calldata func) external",
];

type DefaultError = {
  code: string;
  message: string;
};
interface WalletInfo {
  eoaAddress: string;
  smartWalletAddress: string;
  signer: Wallet;
}

const defaultRpcOptions: JsonRpcApiProviderOptions = {
  batchMaxCount: 1, // Disable batching to avoid rate limits
  batchStallTime: 2000, // Wait 2s before batching
  staticNetwork: Network.from(137),
  polling: false, // Disable automatic polling
};

// Rate limiting configuration
const RATE_LIMIT_CONFIG = {
  slotInterval: 1000, // Wait 1 second between requests
  maxAttempts: 3, // Retry up to 3 times on failure
  retryDelay: 2000, // Wait 2 seconds before retry
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

const getProvider = (url: string): JsonRpcProvider => {
  // Reuse cached provider if available (with throttling already configured)
  if (providerCache.has(url)) {
    return providerCache.get(url)!;
  }

  // Create new provider with rate limiting
  const provider = new JsonRpcProvider(
    buildFetchRequest(url),
    Network.from(137),
    defaultRpcOptions
  );

  // Cache the provider
  providerCache.set(url, provider);
  return provider;
};

// Clear provider cache when RPC changes
const clearProviderCache = (exceptUrl?: string) => {
  if (exceptUrl) {
    const keepProvider = providerCache.get(exceptUrl);
    providerCache.clear();
    if (keepProvider) {
      providerCache.set(exceptUrl, keepProvider);
    }
  } else {
    providerCache.clear();
  }
};

const USDTTransferApp: React.FC = () => {
  const [mnemonic, setMnemonic] = useState("");
  const [smartWalletAddress, setSmartWalletAddress] = useState("");
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [txHash, setTxHash] = useState("");
  const [walletInfo, setWalletInfo] = useState<WalletInfo | null>(null);
  const [usdtBalance, setUsdtBalance] = useState<string | null>(null);
  const [maticBalance, setMaticBalance] = useState<string | null>(null);
  const [loadingBalance, setLoadingBalance] = useState(false);
  const [estimatedGas, setEstimatedGas] = useState<string | null>(null);
  const [rpcOptions, setRpcOptions] = useState<RpcOption[]>([
    { name: DEFAULT_RPC, url: DEFAULT_RPC },
  ]);
  const [selectedRpc, setSelectedRpc] = useState<string>(DEFAULT_RPC);
  const [loadingRpc, setLoadingRpc] = useState<boolean>(true);
  const previousRpcRef = useRef<string>("");
  const reconnectAbortControllerRef = useRef<AbortController | null>(null);
  const balanceAbortControllerRef = useRef<AbortController | null>(null);
  const isReconnectingRef = useRef<boolean>(false);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isFetchingBalancesRef = useRef<boolean>(false);

  // Fetch public RPCs from Chainlist
  useEffect(() => {
    const fetchChainlistRPCs = async () => {
      try {
        setLoadingRpc(true);
        // Chainlist API endpoint for Polygon (chainId: 137)
        const response = await fetch("https://chainid.network/chains.json");
        const chains = await response.json();
        interface ChainInfo {
          chainId: number;
          rpc: string[];
        }
        const polygon = chains.find(
          (chain: ChainInfo) => chain.chainId === 137
        );

        if (polygon && polygon.rpc && Array.isArray(polygon.rpc)) {
          // Filter only public HTTPS RPCs (no API keys, no authentication)
          const publicRPCs = polygon.rpc
            .filter((rpc: string) => {
              const url = typeof rpc === "string" ? rpc : "";
              return (
                url.startsWith("https://") &&
                !url.includes("${") &&
                !url.includes("apiKey") &&
                !url.includes("apikey") &&
                !url.includes("API_KEY") &&
                !url.includes("key=") &&
                !url.includes("auth") &&
                !url.includes("demo") &&
                !url.includes("test")
              );
            })
            .map((rpc: string) => {
              const url = typeof rpc === "string" ? rpc : "";
              // Use URL as name
              return { name: url, url };
            })
            .filter(
              (rpc: RpcOption, index: number, self: RpcOption[]) =>
                index === self.findIndex((t) => t.url === rpc.url)
            ) // Remove duplicates
            .slice(0, 10); // Limit to 10 RPCs

          if (publicRPCs.length > 0) {
            setRpcOptions(publicRPCs);
            setSelectedRpc(publicRPCs[0].url);
          }
        }
      } catch (err) {
        console.error("Failed to fetch RPCs from Chainlist:", err);
        // Keep default RPC on error
        setRpcOptions([{ name: DEFAULT_RPC, url: DEFAULT_RPC }]);
      } finally {
        setLoadingRpc(false);
      }
    };

    fetchChainlistRPCs();
  }, []);

  // Reconnect wallet when RPC changes (if wallet is already imported)
  useEffect(() => {
    // Clear any pending timeout
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    // Cancel any ongoing reconnection and balance fetches
    if (reconnectAbortControllerRef.current) {
      reconnectAbortControllerRef.current.abort();
      reconnectAbortControllerRef.current = null;
    }
    if (balanceAbortControllerRef.current) {
      balanceAbortControllerRef.current.abort();
      balanceAbortControllerRef.current = null;
    }

    // Clear provider cache when RPC changes (keep current RPC provider)
    if (
      previousRpcRef.current !== "" &&
      previousRpcRef.current !== selectedRpc
    ) {
      clearProviderCache(selectedRpc);
    }

    // Only reconnect if RPC actually changed and wallet is imported
    if (
      walletInfo &&
      mnemonic.trim() &&
      previousRpcRef.current !== "" &&
      previousRpcRef.current !== selectedRpc &&
      !isReconnectingRef.current
    ) {
      // Update the previous RPC reference immediately to prevent loops
      previousRpcRef.current = selectedRpc;
      isReconnectingRef.current = true;

      // Debounce the reconnection to avoid rapid changes
      reconnectTimeoutRef.current = setTimeout(() => {
        const abortController = new AbortController();
        reconnectAbortControllerRef.current = abortController;

        const reconnectWallet = async () => {
          try {
            // Check if still valid (RPC hasn't changed again)
            if (
              previousRpcRef.current !== selectedRpc ||
              abortController.signal.aborted
            ) {
              return;
            }

            setError(""); // Clear previous errors

            const provider = getProvider(selectedRpc);
            const wallet = Wallet.fromPhrase(mnemonic);
            const signer = wallet.connect(provider);

            // Check if aborted
            if (abortController.signal.aborted) {
              return;
            }

            setWalletInfo({
              eoaAddress: wallet.address,
              smartWalletAddress: walletInfo.smartWalletAddress,
              signer: signer as unknown as Wallet,
            });

            // Check if aborted before fetching balances
            if (abortController.signal.aborted) {
              return;
            }

            // Update balances with new RPC, passing the abort signal
            await getBalances(
              walletInfo.smartWalletAddress,
              wallet.address,
              selectedRpc,
              abortController.signal
            );
          } catch (err) {
            // Don't set error if aborted
            if (abortController.signal.aborted) {
              return;
            }
            const message = err instanceof Error ? err.message : String(err);
            setError("Failed to reconnect with new RPC: " + message);
          } finally {
            if (!abortController.signal.aborted) {
              isReconnectingRef.current = false;
            }
            if (reconnectAbortControllerRef.current === abortController) {
              reconnectAbortControllerRef.current = null;
            }
          }
        };

        reconnectWallet();
      }, 500); // 500ms debounce
    } else if (previousRpcRef.current === "") {
      // First time, just update the reference
      previousRpcRef.current = selectedRpc;
    }

    // Cleanup function
    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (reconnectAbortControllerRef.current) {
        reconnectAbortControllerRef.current.abort();
        reconnectAbortControllerRef.current = null;
      }
      if (balanceAbortControllerRef.current) {
        balanceAbortControllerRef.current.abort();
        balanceAbortControllerRef.current = null;
      }
      isReconnectingRef.current = false;
      isFetchingBalancesRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRpc]);

  const validateInputs = (): boolean => {
    if (!mnemonic.trim()) {
      setError("Please enter your mnemonic phrase");
      return false;
    }
    if (!smartWalletAddress.trim() || !smartWalletAddress.startsWith("0x")) {
      setError("Please enter a valid smart wallet address");
      return false;
    }
    if (!recipient.trim() || !recipient.startsWith("0x")) {
      setError("Please enter a valid recipient address");
      return false;
    }
    if (!amount || parseFloat(amount) <= 0) {
      setError("Please enter a valid amount");
      return false;
    }
    return true;
  };

  const getBalances = async (
    address: string,
    eoaAddress: string,
    rpcUrl?: string,
    signal?: AbortSignal
  ): Promise<void> => {
    // Cancel any ongoing balance fetch
    if (balanceAbortControllerRef.current) {
      balanceAbortControllerRef.current.abort();
      balanceAbortControllerRef.current = null;
    }

    // Prevent multiple simultaneous calls
    if (isFetchingBalancesRef.current) {
      console.log("Balance fetch already in progress, skipping...");
      return;
    }

    isFetchingBalancesRef.current = true;
    const abortController = new AbortController();
    balanceAbortControllerRef.current = abortController;

    // Use provided signal or create a combined one
    const finalSignal = signal || abortController.signal;

    setLoadingBalance(true);
    try {
      const rpc = rpcUrl || selectedRpc;
      console.log("Fetching balances for:", address, "using RPC:", rpc);
      const provider = getProvider(rpc);

      // Check if aborted before making requests
      if (finalSignal.aborted) {
        return;
      }

      // Get USDT balance
      const usdtContract = new Contract(
        USDT_POLYGON_ADDRESS,
        USDT_ABI,
        provider
      );
      const balance = await usdtContract.balanceOf(address);

      // Check if aborted
      if (finalSignal.aborted) {
        return;
      }

      const decimals = await usdtContract.decimals();
      const formattedBalance = formatUnits(balance, decimals);

      // Check if aborted before setting state
      if (finalSignal.aborted) {
        return;
      }

      setUsdtBalance(formattedBalance);

      // Get MATIC balance
      const maticBalanceWei = await provider.getBalance(eoaAddress);

      // Check if aborted
      if (finalSignal.aborted) {
        return;
      }

      const formattedMaticBalance = formatEther(maticBalanceWei);

      // Check if aborted before setting state
      if (finalSignal.aborted) {
        return;
      }

      setMaticBalance(formattedMaticBalance);
    } catch (err) {
      // Don't set error if aborted
      if (finalSignal.aborted) {
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      setError("Failed to fetch balances: " + message);
    } finally {
      isFetchingBalancesRef.current = false;
      if (!finalSignal.aborted) {
        setLoadingBalance(false);
      }
      if (balanceAbortControllerRef.current === abortController) {
        balanceAbortControllerRef.current = null;
      }
    }
  };

  const handleImportWallet = async (): Promise<void> => {
    if (!mnemonic.trim()) {
      setError("Please enter your mnemonic phrase");
      return;
    }
    if (!smartWalletAddress.trim() || !smartWalletAddress.startsWith("0x")) {
      setError("Please enter a valid smart wallet address");
      return;
    }

    setError("");
    setSuccess("");
    setLoading(true);

    try {
      const provider = getProvider(selectedRpc);
      const wallet = Wallet.fromPhrase(mnemonic);
      const signer = wallet.connect(provider);

      setWalletInfo({
        eoaAddress: wallet.address,
        smartWalletAddress: smartWalletAddress,
        signer: signer as unknown as Wallet,
      });

      // Update RPC reference when wallet is first imported
      previousRpcRef.current = selectedRpc;

      await getBalances(smartWalletAddress, wallet.address);

      setSuccess("Wallet imported successfully!");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError("Failed to import wallet: " + message);
    } finally {
      setLoading(false);
    }
  };

  const handleSendUSDT = async (): Promise<void> => {
    if (!validateInputs()) return;
    if (!walletInfo) {
      setError("Please import your wallet first");
      return;
    }

    setError("");
    setSuccess("");
    setTxHash("");
    setEstimatedGas(null);
    setLoading(true);

    try {
      const provider = getProvider(selectedRpc);
      const { signer } = walletInfo;

      // Encode USDT transfer
      const iface = new Interface(USDT_ABI);
      const amountInSmallestUnit = parseUnits(amount, 6); // USDT has 6 decimals

      // check if the amount is greater than the balance
      if (amountInSmallestUnit > parseUnits(usdtBalance || "0", 6)) {
        setError("Insufficient USDT balance");
        setLoading(false);
        return;
      }
      const data = iface.encodeFunctionData("transfer", [
        recipient,
        amountInSmallestUnit,
      ]);

      // Connect to smart wallet contract
      const smartWallet = new Contract(
        smartWalletAddress,
        SMART_WALLET_ABI,
        signer
      );

      // Estimate gas fees
      const feeData = await provider.getFeeData();
      const gasLimit = 200000n; // Estimate for execute call
      // gas + 20% margin
      const maxFeePerGas =
        ((feeData.maxFeePerGas || feeData.gasPrice || 0n) * 200n) / 100n;
      const estimatedGasCost = gasLimit * maxFeePerGas;
      const estimatedGasCostInMatic = formatEther(estimatedGasCost);

      setEstimatedGas(estimatedGasCostInMatic);

      // Check if user has enough MATIC for gas
      const maticBalanceBigInt = parseEther(maticBalance || "0");
      if (maticBalanceBigInt < estimatedGasCost) {
        setError(
          `Insufficient MATIC for gas fees. You have ${maticBalance} MATIC but need approximately ${estimatedGasCostInMatic} MATIC for this transaction.`
        );
        setLoading(false);
        return;
      }

      console.log("Executing USDT transfer through smart wallet...");

      // Execute the transaction through the smart wallet
      const tx = await smartWallet.execute(
        USDT_POLYGON_ADDRESS,
        0, // value in native token (0 for ERC20 transfers)
        data,
        {
          gasLimit: gasLimit,
        }
      );

      console.log("Transaction sent:", tx.hash);

      // Wait for confirmation
      const receipt = await tx.wait();
      console.log("Transaction confirmed:", receipt.hash);

      setTxHash(receipt.hash);
      setSuccess(
        `Transaction successful! ${amount} USDT sent to ${recipient.substr(
          0,
          6
        )}...${recipient.substr(-4)}`
      );

      // Refresh balances
      await getBalances(smartWalletAddress, walletInfo.eoaAddress);

      setAmount("");
      setRecipient("");
    } catch (err) {
      console.error("Transaction error:", err);
      const error = err as DefaultError;
      const message = error.message;
      const code = error.code;
      // Better error messages
      let errorMsg = "Transaction failed: ";
      if (code === "CALL_EXCEPTION") {
        errorMsg +=
          "Smart wallet execution failed. Make sure your wallet supports the execute() function.";
      } else if (message.includes("insufficient funds")) {
        errorMsg += "Insufficient funds for gas fees.";
      } else {
        errorMsg += message;
      }

      setError(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-purple-900 via-purple-800 to-indigo-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-2xl shadow-2xl p-8">
          <div className="text-center mb-8">
            <div className="inline-block p-3 bg-purple-100 rounded-full mb-4">
              <Send className="w-8 h-8 text-purple-600" />
            </div>
            <h1 className="text-3xl font-bold text-gray-800 mb-2">
              USDT Transfer
            </h1>
            <p className="text-gray-600">Send USDT on Polygon Network</p>
            <p className="text-xs text-purple-600 mt-2">(Modular Account V2)</p>
          </div>

          {error && (
            <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}

          {success && (
            <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg">
              <div className="flex items-start gap-3 mb-2">
                <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-green-800">{success}</p>
              </div>
              {txHash && (
                <a
                  href={`https://polygonscan.com/tx/${txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-sm text-purple-600 hover:text-purple-700 font-medium mt-2"
                >
                  View on PolygonScan
                  <ExternalLink className="w-4 h-4" />
                </a>
              )}
            </div>
          )}

          <div className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                RPC Endpoint (Public from Chainlist)
              </label>
              {loadingRpc ? (
                <div className="w-full px-4 py-3 border border-gray-300 rounded-lg bg-gray-50 flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin text-purple-600" />
                  <span className="text-sm text-gray-600">
                    Loading RPCs from Chainlist...
                  </span>
                </div>
              ) : (
                <select
                  value={selectedRpc}
                  onChange={(e) => setSelectedRpc(e.target.value)}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent transition-all bg-white"
                  disabled={loading}
                >
                  {rpcOptions.map((rpc, index) => (
                    <option key={index} value={rpc.url}>
                      {rpc.name}
                    </option>
                  ))}
                </select>
              )}
              <p className="text-xs text-gray-500 mt-1">
                Current:{" "}
                {rpcOptions.find((rpc) => rpc.url === selectedRpc)?.name ||
                  selectedRpc}
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Mnemonic Phrase
              </label>
              <textarea
                value={mnemonic}
                onChange={(e) => setMnemonic(e.target.value)}
                placeholder="Enter your 12 or 24 word mnemonic phrase"
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent transition-all resize-none"
                rows={3}
                disabled={loading || !!walletInfo}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Smart Wallet Address
              </label>
              <input
                type="text"
                value={smartWalletAddress}
                onChange={(e) => setSmartWalletAddress(e.target.value)}
                placeholder="0x..."
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent transition-all"
                disabled={loading || !!walletInfo}
              />
            </div>

            {!walletInfo ? (
              <button
                onClick={handleImportWallet}
                disabled={loading}
                className="w-full py-3 px-4 bg-purple-600 hover:bg-purple-700 text-white font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Importing...
                  </>
                ) : (
                  <>
                    <LucideWallet className="w-5 h-5" />
                    Import Wallet
                  </>
                )}
              </button>
            ) : (
              <>
                <div className="p-4 bg-purple-50 rounded-lg border border-purple-200 space-y-3">
                  <div>
                    <p className="text-xs text-gray-600 mb-1">
                      Smart Wallet Address
                    </p>
                    <p className="text-sm font-mono text-gray-800 break-all">
                      {walletInfo.smartWalletAddress}
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <p className="text-xs text-gray-600 mb-1">USDT Balance</p>
                      <p className="text-xl font-bold text-purple-600">
                        {loadingBalance ? (
                          <Loader2 className="w-4 h-4 animate-spin inline" />
                        ) : (
                          `${usdtBalance || "0"}`
                        )}
                      </p>
                      <p className="text-xs text-gray-500">USDT</p>
                    </div>
                  </div>
                  <div className="mt-2">
                    <div>
                      <p className="text-xs text-gray-600 mb-1">
                        Signer Wallet
                      </p>
                      <p className="text-sm font-mono text-gray-800 break-all">
                        {walletInfo.eoaAddress}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-600 mb-1">
                        MATIC Balance
                      </p>
                      <p className="text-xl font-bold text-indigo-600">
                        {loadingBalance ? (
                          <Loader2 className="w-4 h-4 animate-spin inline" />
                        ) : (
                          `${maticBalance || "0"}`
                        )}
                      </p>
                      <p className="text-xs text-gray-500">MATIC</p>
                    </div>
                  </div>
                  {estimatedGas && (
                    <div className="pt-2 border-t border-purple-200">
                      <p className="text-xs text-gray-600">
                        Estimated Gas Fee:{" "}
                        <span className="font-semibold text-gray-800">
                          ~{parseFloat(estimatedGas).toFixed(6)} MATIC
                        </span>
                      </p>
                    </div>
                  )}
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
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent transition-all"
                    disabled={loading}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Amount (USDT)
                  </label>
                  <input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    step="0.01"
                    min="0"
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent transition-all"
                    disabled={loading}
                  />
                </div>

                {error && (
                  <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 text-red-600 flex-shrink-0 mt-0.5" />
                    <p className="text-sm text-red-800">{error}</p>
                  </div>
                )}

                {success && (
                  <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg">
                    <div className="flex items-start gap-3 mb-2">
                      <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
                      <p className="text-sm text-green-800">{success}</p>
                    </div>
                    {txHash && (
                      <a
                        href={`https://polygonscan.com/tx/${txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 text-sm text-purple-600 hover:text-purple-700 font-medium mt-2"
                      >
                        View on PolygonScan
                        <ExternalLink className="w-4 h-4" />
                      </a>
                    )}
                  </div>
                )}

                <div className="mt-6 p-4 bg-info-50 border border-info-200 rounded-lg">
                  <p className="text-xs text-info-800">
                    <strong>Attention:</strong> You need to have enough MATIC in
                    your Signer Wallet to cover the gas fee for the transaction.
                  </p>
                </div>
                <button
                  onClick={handleSendUSDT}
                  disabled={loading}
                  className="w-full py-3 px-4 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white font-medium rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg"
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      Sending...
                    </>
                  ) : (
                    <>
                      <Send className="w-5 h-5" />
                      Send USDT
                    </>
                  )}
                </button>
              </>
            )}
          </div>

          <div className="mt-6 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
            <p className="text-xs text-yellow-800">
              <strong>⚠️ Security Warning:</strong> Never share your mnemonic
              phrase with anyone. This app uses direct smart wallet execution
              through the Polygon RPC.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default USDTTransferApp;
