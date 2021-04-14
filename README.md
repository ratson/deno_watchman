# deno_watchman

## Usage

```ts
import { Client } from "https://deno.land/x/watchman/mod.ts";

const client = new Client();

console.log(
  await client.capabilityCheck({ optional: [], required: ["relative_root"] }),
);

client.end();
```
