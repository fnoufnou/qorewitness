/** Reads pqcKeyStatus for a testnet validator account to learn the live return format. */
import { createPublicClient, encodeFunctionData, http, toHex, type Hex } from "viem";
import { bech32 } from "@scure/base";
const REST = "https://api-testnet.qore.host";
const v = await (await fetch(`${REST}/cosmos/staking/v1beta1/validators?pagination.limit=3`)).json();
const valoper: string = v.validators[0].operator_address;
const evm = toHex(bech32.fromWords(bech32.decode(valoper as `${string}1${string}`).words)) as Hex;
const client = createPublicClient({ transport: http("https://evm-testnet.qore.host") });
const call = encodeFunctionData({
  abi: [{ type: "function", name: "pqcKeyStatus", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [] }],
  functionName: "pqcKeyStatus", args: [evm],
});
const ret = (await client.call({ to: "0x0000000000000000000000000000000000000a02", data: call })).data!;
const words = [0, 1, 2, 3, 4].map((i) => BigInt("0x" + (ret.slice(2 + i * 64, 2 + (i + 1) * 64) || "0")));
console.log({ valoper, evm, bytes: (ret.length - 2) / 2, words });
