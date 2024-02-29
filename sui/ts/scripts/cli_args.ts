import yargs from "yargs";

export function createParser() {
  const parser = yargs
    .env("CONFIGURE_TBR")
    .options({
      network: {
        alias: "n",
        string: true,
        describe: "Network context where the script will execute.",
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