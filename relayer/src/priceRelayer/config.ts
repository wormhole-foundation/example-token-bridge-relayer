import * as fs from "fs";

export interface RelayerConfig {
  chainId: number;
  tokenId: string;
  tokenContract: string;
}

export interface PriceConfig {
  fetchPricesInterval: number;
  updatePriceChangePercentage: number;
  pricePrecision: number;
  relayers: RelayerConfig[];
}

export function readPriceConfig(configPath: string): PriceConfig {
  const config: PriceConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  return config;
}
