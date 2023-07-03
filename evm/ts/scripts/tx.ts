import { ethers } from "ethers";
import { SupportedChainId } from "./config";

export type Check = () => Promise<string>;

export class TxResult {
  private constructor(
    public readonly txSuccess: boolean,
    public readonly successMessage: string,
    public readonly check: () => Promise<boolean>
  ) {}

  static create(
    txReceipt: ethers.ContractReceipt,
    successMessage: string,
    check: () => Promise<boolean>
  ) {
    return new TxResult(txReceipt.status === 1, successMessage, check);
  }

  static Success(successMessage: string) {
    return new TxResult(true, successMessage, async () => true);
  }
}

export function handleFailure(checks: Check[], result: TxResult, failureMessage: string) {
  if (result.txSuccess === false) {
    console.log(failureMessage);
  } else {
    checks.push(() => doCheck(result, result.successMessage, failureMessage));
  }
}

async function doCheck(
  result: TxResult,
  successMessage: string,
  failureMessage: string
): Promise<string> {
  const success = await result.check().catch((error) => {
    failureMessage += `\n ${error?.stack || error}`;
    return false;
  });
  if (!success) return failureMessage;
  return successMessage;
}

async function estimateGasDeploy(
  factory: ethers.ContractFactory,
  args: unknown[]
): Promise<ethers.BigNumber> {
  const deployTxArgs = factory.getDeployTransaction(...args);
  return factory.signer.estimateGas(deployTxArgs);
};

export async function buildOverridesDeploy(
  factory: ethers.ContractFactory,
  chainId: SupportedChainId,
  args: unknown[]
): Promise<ethers.Overrides> {
  return buildOverrides(() => estimateGasDeploy(factory, args), chainId);
};

async function overshootEstimationGas(
  estimate: () => Promise<ethers.BigNumber>
): Promise<ethers.BigNumber> {
  const gasEstimate = await estimate();
  // we multiply gas estimation by a factor 1.1 to avoid slightly skewed estimations from breaking transactions.
  return gasEstimate.mul(1100).div(1000);
}

export async function buildOverrides(
  estimate: () => Promise<ethers.BigNumber>,
  chainId: SupportedChainId
): Promise<ethers.Overrides> {
  const overrides: ethers.Overrides = {
    gasLimit: await overshootEstimationGas(estimate),
  };
  if (chainId === 5 || chainId === 10) {
    // Polygon or Fantom
    overrides.type = 0;
  }
  return overrides;
}
