import React, { useState } from "react";
import {
  Wallet,
  JsonRpcProvider,
  Contract,
  Interface,
  formatUnits,
  parseUnits,
  formatEther,
  parseEther,
} from "ethers";

import {
  AlertCircle,
  Loader2,
  CheckCircle,
  Send,
  Wallet as LucideWallet,
  ExternalLink,
} from "lucide-react";

const USDT_POLYGON_ADDRESS = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";
const POLYGON_RPC = "https://polygon-rpc.com";

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
    eoaAddress: string
  ): Promise<void> => {
    setLoadingBalance(true);
    try {
      console.log("Fetching balances for:", address);
      console.log("Fetching balances for:", eoaAddress);
      const provider = new JsonRpcProvider(POLYGON_RPC);

      // Get USDT balance
      const usdtContract = new Contract(
        USDT_POLYGON_ADDRESS,
        USDT_ABI,
        provider
      );
      const balance = await usdtContract.balanceOf(address);
      const decimals = await usdtContract.decimals();

      const formattedBalance = formatUnits(balance, decimals);
      setUsdtBalance(formattedBalance);

      // Get MATIC balance
      const maticBalanceWei = await provider.getBalance(eoaAddress);
      const formattedMaticBalance = formatEther(maticBalanceWei);
      setMaticBalance(formattedMaticBalance);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError("Failed to fetch balances: " + message);
    } finally {
      setLoadingBalance(false);
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
      const provider = new JsonRpcProvider(POLYGON_RPC);
      const wallet = Wallet.fromPhrase(mnemonic);
      const signer = wallet.connect(provider);

      setWalletInfo({
        eoaAddress: wallet.address,
        smartWalletAddress: smartWalletAddress,
        signer: signer as unknown as Wallet,
      });

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
      const provider = new JsonRpcProvider(POLYGON_RPC);
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
      const maxFeePerGas = feeData.maxFeePerGas || feeData.gasPrice || 0n;
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
