import {
  SuiClient,
  SuiTransactionBlockResponse,
} from "@mysten/sui.js/client";
import {
  TransactionBlock,
} from "@mysten/sui.js/transactions";
import { Ed25519Keypair } from "@mysten/sui.js/dist/cjs/keypairs/ed25519";

export const pollTransactionForEffectsCert = async (
  client: SuiClient,
  digest: string
): Promise<SuiTransactionBlockResponse> => {
  return new Promise(async (resolve, reject) => {
    let transactionCompleted = false;

    while (!transactionCompleted) {
      try {
        const transaction = await client.getTransactionBlock({
          digest,
          options: {
            showEffects: true,
          },
        });

        const completed = transaction.effects!.status.status === "success";
        transactionCompleted = completed;
        if (completed) return resolve(transaction);
      } catch (error) {
        reject(error);
      }
    }
  });
};

export const executeTransactionBlock = async (
  client: SuiClient,
  signer: Ed25519Keypair,
  transactionBlock: TransactionBlock
): Promise<SuiTransactionBlockResponse> => {
  // Let caller handle parsing and logging info
  return client.signAndExecuteTransactionBlock({
    signer,
    transactionBlock,
    requestType: "WaitForLocalExecution",
    options: {
      showInput: true,
      showEvents: true,
      showObjectChanges: true,
      showBalanceChanges: true,
    },
  });
};
