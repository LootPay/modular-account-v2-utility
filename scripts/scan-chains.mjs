// Scans every chain on chainid.network for the Modular Account V2 contracts
// needed to deploy and operate a SemiModularAccount without a bundler, and
// writes the supported ones to src/chains.ts, together with well-known ERC20
// tokens for each chain (from the Uniswap and CoinGecko token lists,
// verified on-chain).
//
// Usage: node scripts/scan-chains.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Interface, getAddress } from "ethers";

const FACTORY = "0x00000000000017c61b5bEe81050EC8eFc9c6fecd";
const SEMI_MODULAR_ACCOUNT_IMPL = "0x000000000000c5A9089039570Dd36455b5C07383";

const CONCURRENCY = 60;
const RPCS_TO_TRY = 4;
const RPCS_TO_KEEP = 10;
const TIMEOUT_MS = 6000;

// Tokens offered in the UI, in display order. The wrapped native token
// ("W" + native symbol, e.g. WAVAX) is added per chain.
const FAMOUS_SYMBOLS = [
  "USDC",
  "USDT",
  "USDT0",
  "DAI",
  "USDe",
  "PYUSD",
  "FDUSD",
  "WETH",
  "WBTC",
  "cbBTC",
  "LINK",
  "UNI",
  "AAVE",
];

// Circle's testnet USDC, since the public token lists only cover mainnets.
const TESTNET_TOKENS = {
  11155111: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", // Ethereum Sepolia
  84532: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Base Sepolia
  421614: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", // Arbitrum Sepolia
  11155420: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7", // OP Sepolia
  43113: "0x5425890298aed601595a70AB815c96711a31Bc65", // Avalanche Fuji
  80002: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582", // Polygon Amoy
  1301: "0x31d0220469e10c4E71834a79b1f276d740d3768F", // Unichain Sepolia
};

const UNISWAP_TOKEN_LIST = "https://tokens.uniswap.org";
const COINGECKO_PLATFORMS = "https://api.coingecko.com/api/v3/asset_platforms";
const coingeckoTokenList = (platform) =>
  `https://tokens.coingecko.com/${platform}/all.json`;

const erc20 = new Interface([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

const outFile = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/chains.ts"
);

const isPublicRpc = (url) =>
  typeof url === "string" &&
  url.startsWith("https://") &&
  !/\$\{|api_?key|key=|auth|demo/i.test(url);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Retries with backoff, since CoinGecko rate limits bursts of requests
const fetchJson = async (url, attempts = 4) => {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (res.status === 404) throw new Error(`${url}: HTTP 404`);
      if (!res.ok) throw Object.assign(new Error(`${url}: HTTP ${res.status}`), { retry: true });
      return await res.json();
    } catch (err) {
      if (attempt >= attempts || err.message.endsWith("HTTP 404")) throw err;
      await sleep(2000 * attempt);
    }
  }
};

const rpcCall = async (url, method, params) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
};

const hasCode = async (url, address) =>
  (await rpcCall(url, "eth_getCode", [address, "latest"])).length > 2;

// Public RPCs rate limit aggressively, so fall back to the chain's other RPCs.
const callView = async (rpcs, address, fn) => {
  let lastError;
  const urls = rpcs.slice(0, RPCS_TO_TRY);
  for (const [i, url] of [...urls, ...urls].entries()) {
    if (i === urls.length) await sleep(1500);
    try {
      const result = await rpcCall(url, "eth_call", [
        { to: address, data: erc20.encodeFunctionData(fn) },
        "latest",
      ]);
      return erc20.decodeFunctionResult(fn, result)[0];
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
};

// Returns the first RPC that answers with the right chain id, plus whether
// both contracts are deployed there; null when no RPC is reachable.
const checkChain = async (chain, rpcs) => {
  for (const url of rpcs.slice(0, RPCS_TO_TRY)) {
    try {
      const chainId = parseInt(await rpcCall(url, "eth_chainId", []), 16);
      if (chainId !== chain.chainId) continue;
      const [factory, impl] = await Promise.all([
        hasCode(url, FACTORY),
        hasCode(url, SEMI_MODULAR_ACCOUNT_IMPL),
      ]);
      return { url, supported: factory && impl };
    } catch {
      // try the next RPC
    }
  }
  return null;
};

const isTestnet = (chain) =>
  (chain.faucets?.length ?? 0) > 0 ||
  /test|sepolia|goerli|holesky|hoodi|fuji|amoy|devnet|curtis/i.test(chain.name);

// chainId -> Map(lowercase symbol -> list token entry). Uniswap entries win
// over CoinGecko ones because that list is curated per chain.
const loadTokenCandidates = async (chainIds) => {
  const byChain = new Map();
  const add = (chainId, token) => {
    if (!byChain.has(chainId)) byChain.set(chainId, new Map());
    const tokens = byChain.get(chainId);
    const key = token.symbol.toLowerCase();
    if (!tokens.has(key)) tokens.set(key, token);
  };

  try {
    const uniswap = await fetchJson(UNISWAP_TOKEN_LIST);
    for (const t of uniswap.tokens) {
      if (chainIds.has(t.chainId)) add(t.chainId, t);
    }
  } catch (err) {
    console.warn("Uniswap token list unavailable:", err.message);
  }

  try {
    const platforms = await fetchJson(COINGECKO_PLATFORMS);
    // Sequential to stay under CoinGecko's rate limit
    for (const p of platforms.filter((p) => chainIds.has(p.chain_identifier))) {
      try {
        const list = await fetchJson(coingeckoTokenList(p.id));
        for (const t of list.tokens) add(p.chain_identifier, t);
      } catch (err) {
        console.warn(`CoinGecko list for ${p.id} unavailable:`, err.message);
      }
    }
  } catch (err) {
    console.warn("CoinGecko token lists unavailable:", err.message);
  }

  for (const [chainId, address] of Object.entries(TESTNET_TOKENS)) {
    if (chainIds.has(Number(chainId))) {
      add(Number(chainId), { address, symbol: "USDC", name: "USD Coin", decimals: 6 });
    }
  }

  return byChain;
};

// Picks the famous tokens listed for a chain and keeps only those whose
// on-chain symbol and decimals match the list entry.
const resolveTokens = async (chain, candidates) => {
  if (!candidates) return [];
  const wanted = [...FAMOUS_SYMBOLS, `W${chain.nativeSymbol}`];
  const seen = new Set();
  const picks = [];
  for (const symbol of wanted) {
    const token = candidates.get(symbol.toLowerCase());
    if (!token) continue;
    const address = getAddress(token.address);
    if (seen.has(address)) continue;
    seen.add(address);
    picks.push(token);
  }

  // Sequential to stay under public RPC rate limits
  const verified = [];
  for (const token of picks) {
    try {
      const symbol = await callView(chain.rpcs, token.address, "symbol");
      const decimals = await callView(chain.rpcs, token.address, "decimals");
      if (Number(decimals) !== token.decimals) continue;
      verified.push({
        address: getAddress(token.address),
        symbol,
        name: token.name,
        decimals: Number(decimals),
      });
    } catch {
      // not a working ERC20 on this chain
    }
  }
  return verified;
};

const chains = await (await fetch("https://chainid.network/chains.json")).json();
const supported = [];
let next = 0;
let reachable = 0;

const worker = async () => {
  while (next < chains.length) {
    const chain = chains[next++];
    const rpcs = [...new Set((chain.rpc || []).filter(isPublicRpc))];
    const result = await checkChain(chain, rpcs);
    if (!result) continue;
    reachable++;
    if (!result.supported) continue;
    supported.push({
      chainId: chain.chainId,
      name: chain.name,
      nativeSymbol: chain.nativeCurrency?.symbol ?? "ETH",
      explorer: chain.explorers?.[0]?.url?.replace(/\/$/, "") ?? null,
      testnet: isTestnet(chain),
      // Working RPC first, then the remaining public ones as fallbacks.
      rpcs: [result.url, ...rpcs.filter((u) => u !== result.url)].slice(
        0,
        RPCS_TO_KEEP
      ),
      tokens: [],
    });
  }
};

await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const candidates = await loadTokenCandidates(
  new Set(supported.map((c) => c.chainId))
);
await Promise.all(
  supported.map(async (chain) => {
    chain.tokens = await resolveTokens(chain, candidates.get(chain.chainId));
  })
);

supported.sort(
  (a, b) => Number(a.testnet) - Number(b.testnet) || a.name.localeCompare(b.name)
);

const source = `// Generated by scripts/scan-chains.mjs on ${new Date()
  .toISOString()
  .slice(0, 10)}. Do not edit by hand.
// Chains where the Modular Account V2 factory and SemiModularAccount
// implementation are deployed, with well-known ERC20 tokens on each.

export interface KnownToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
}

export interface SupportedChain {
  chainId: number;
  name: string;
  nativeSymbol: string;
  explorer: string | null;
  testnet: boolean;
  rpcs: string[];
  tokens: KnownToken[];
}

export const SUPPORTED_CHAINS: SupportedChain[] = ${JSON.stringify(
  supported,
  null,
  2
)};
`;

fs.writeFileSync(outFile, source);
const tokenCount = supported.reduce((n, c) => n + c.tokens.length, 0);
console.log(
  `Scanned ${chains.length} chains, ${reachable} reachable, ${supported.length} supported, ${tokenCount} tokens -> ${outFile}`
);
for (const c of supported) {
  console.log(
    `${c.chainId} ${c.name}: ${c.tokens.map((t) => t.symbol).join(", ") || "-"}`
  );
}
