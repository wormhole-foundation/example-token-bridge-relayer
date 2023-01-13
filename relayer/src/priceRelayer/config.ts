import * as fs from "fs";

export interface RelayerConfig {
  chainId: number;
  tokenId: string;
  tokenContract: string;
  pricePrecision: number;
}

export interface PriceConfig {
  fetchPricesInterval: number;
  updatePriceChangePercentage: number;
  relayers: RelayerConfig[];
}

export function readPriceConfig(configPath: string): PriceConfig {
  const config: PriceConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  return config;
}
