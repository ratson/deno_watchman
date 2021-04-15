import { Client } from "../mod.ts";

const client = new Client();

console.log(
  await client.capabilityCheck({ optional: [], required: ["relative_root"] }),
);

client.end();
