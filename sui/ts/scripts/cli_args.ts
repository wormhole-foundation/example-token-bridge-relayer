import yargs from "yargs";

export function createParser() {
  const parser = yargs
    .env("CONFIGURE_TBR")
    .options({
      network: {
        alias: "v",
        string: true,
        describe: "Redemption VAA",
        choices: ["mainnet", "testnet"],
        require: true,
        type: "string",
      },
      config: {
        alias: "c",
        string: true,
        boolean: false,
        description: "Configuration filepath.",
        required: true,
      },
    });

  return parser;
}