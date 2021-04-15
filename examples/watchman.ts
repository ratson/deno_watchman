import Watchman from "../mod.ts";

const watchman = new Watchman();

console.log(await watchman.check());

watchman.end();
