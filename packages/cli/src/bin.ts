import { main } from "./commands.ts";

process.exitCode = await main(process.argv.slice(2));
