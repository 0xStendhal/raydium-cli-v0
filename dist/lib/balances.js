"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchRpcBalances = exports.fetchSolBalance = exports.formatAtomicAmount = void 0;
const bn_js_1 = __importDefault(require("bn.js"));
const web3_js_1 = require("@solana/web3.js");
const spl_token_1 = require("@solana/spl-token");
const connection_1 = require("./connection");
function formatAtomicAmount(raw, decimals) {
    if (decimals <= 0)
        return raw.toString();
    const rawStr = raw.toString().padStart(decimals + 1, "0");
    const whole = rawStr.slice(0, -decimals);
    const frac = rawStr.slice(-decimals).replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : whole;
}
exports.formatAtomicAmount = formatAtomicAmount;
async function fetchSolBalance(owner) {
    const connection = await (0, connection_1.getConnection)();
    const lamports = await connection.getBalance(owner);
    const raw = new bn_js_1.default(lamports.toString());
    return {
        mint: "SOL",
        symbol: "SOL",
        name: "solana",
        amount: formatAtomicAmount(raw, 9),
        raw: raw.toString(),
        decimals: 9
    };
}
exports.fetchSolBalance = fetchSolBalance;
async function fetchRpcBalances(owner) {
    const connection = await (0, connection_1.getConnection)();
    const [solBalance, splAccounts, token2022Accounts] = await Promise.all([
        connection.getBalance(owner),
        connection.getTokenAccountsByOwner(owner, { programId: spl_token_1.TOKEN_PROGRAM_ID }),
        connection.getTokenAccountsByOwner(owner, { programId: spl_token_1.TOKEN_2022_PROGRAM_ID })
    ]);
    const tokenAccounts = [...splAccounts.value, ...token2022Accounts.value].map(({ account }) => spl_token_1.AccountLayout.decode(account.data));
    const mintSet = new Set();
    tokenAccounts.forEach((account) => mintSet.add(account.mint.toBase58()));
    const mintList = Array.from(mintSet);
    const mintInfos = new Map();
    const batchSize = 100;
    for (let i = 0; i < mintList.length; i += batchSize) {
        const batch = mintList.slice(i, i + batchSize);
        const accounts = await connection.getMultipleAccountsInfo(batch.map((mint) => new web3_js_1.PublicKey(mint)));
        accounts.forEach((info, idx) => {
            if (!info)
                return;
            const decoded = spl_token_1.MintLayout.decode(info.data);
            mintInfos.set(batch[idx], decoded.decimals);
        });
    }
    const balances = [
        {
            mint: "SOL",
            symbol: "SOL",
            name: "solana",
            amount: formatAtomicAmount(new bn_js_1.default(solBalance.toString()), 9),
            raw: solBalance.toString(),
            decimals: 9
        }
    ];
    const tokenTotals = new Map();
    tokenAccounts.forEach((account) => {
        const mint = account.mint.toBase58();
        const raw = new bn_js_1.default(account.amount.toString());
        tokenTotals.set(mint, (tokenTotals.get(mint) ?? new bn_js_1.default(0)).add(raw));
    });
    tokenTotals.forEach((raw, mint) => {
        if (raw.isZero())
            return;
        const decimals = mintInfos.get(mint) ?? 0;
        const symbol = mint.slice(0, 6);
        balances.push({
            mint,
            symbol,
            name: symbol,
            amount: formatAtomicAmount(raw, decimals),
            raw: raw.toString(),
            decimals
        });
    });
    return balances;
}
exports.fetchRpcBalances = fetchRpcBalances;
