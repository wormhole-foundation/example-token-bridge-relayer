import { ethers } from "ethers";
import { WALLET_PRIVATE_KEY } from "./consts";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

export interface SignerArguments {
  useLedger: boolean;
  derivationPath?: string;
}

/**
 * @dev Use this to enrich your argument parsing with signer options
 */
export function addSignerArgsParser<T>(parser: yargs.Argv<T>) {
  return parser
    .option("ledger", {
      string: false,
      boolean: true,
      default: false,
      description: "Use ledger to sign transactions",
      required: false,
    })
    .option("derivation-path", {
      string: true,
      boolean: false,
      description:
        "BIP32 derivation path to use. Used only with ledger devices.",
      required: false,
    });
}

/**
 * @dev Use this if you don't parse any arguments and need to provide
 * the option of using a ledger hardware wallet.
 */
export async function parseSignerArgs(): Promise<SignerArguments> {
  const signerArgsParser = addSignerArgsParser(yargs())
    .help("h")
    .alias("h", "help");
  const parsed = await signerArgsParser.parse(hideBin(process.argv));

  const args: SignerArguments = {
    useLedger: parsed.ledger,
    derivationPath: parsed.derivationPath,
  };

  return args;
}

export async function getSigner(
  args: SignerArguments,
  provider: ethers.providers.Provider
): Promise<ethers.Signer> {
  if (args.useLedger) {
    const { LedgerSigner } = await import("@xlabs-xyz/ledger-signer");
    return LedgerSigner.create(provider, args.derivationPath);
  }

  return new ethers.Wallet(WALLET_PRIVATE_KEY, provider);
}
