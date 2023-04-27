import {
  TransactionDigest,
  RawSigner,
  TransactionBlock,
  SuiTransactionBlockResponse,
} from "@mysten/sui.js";

export const pollTransactionForEffectsCert = async (
  signer: RawSigner,
  digest: TransactionDigest
): Promise<SuiTransactionBlockResponse> => {
  return new Promise(async (resolve, reject) => {
    let transactionCompleted = false;

    while (!transactionCompleted) {
      try {
        const transaction = await signer.provider.getTransactionBlock({
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
  signer: RawSigner,
  transactionBlock: TransactionBlock
): Promise<SuiTransactionBlockResponse> => {
  // Let caller handle parsing and logging info
  return signer.signAndExecuteTransactionBlock({
    transactionBlock,
    requestType: "WaitForLocalExecution",
    options: {
      showInput: true,
      showEvents: true,
      showObjectChanges: true,
    },
  });
};
