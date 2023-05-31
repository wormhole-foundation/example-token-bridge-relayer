import {ethers} from "ethers";

export interface SwapRateUpdate {
  token: string;
  value: ethers.BigNumber;
}
