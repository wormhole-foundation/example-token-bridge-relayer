import { ChainId } from "@certusone/wormhole-sdk";

export interface SendTokensParams {
  amount: number;
  toNativeTokenAmount: number;
  recipientAddress: Buffer;
  recipientChain: ChainId;
  batchId: number;
  wrapNative: boolean;
}
