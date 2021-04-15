# deno_watchman

## Usage

```ts
import Watchman from "https://deno.land/x/watchman/mod.ts";

const watchman = new Watchman();

console.log(await watchman.check();

client.end();
```


```ts
import { Client } from "https://deno.land/x/watchman/mod.ts";

const client = new Client();

console.log(
  await client.capabilityCheck({ optional: [], required: ["relative_root"] }),
);

client.end();
```
