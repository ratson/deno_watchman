// deno-lint-ignore-file camelcase
import { resolve } from "https://deno.land/std@0.108.0/path/mod.ts";
import { v4 } from "https://deno.land/std@0.108.0/uuid/mod.ts";
import { Client } from "./client.ts";

/**
 * A high-level Watchman client
 */
export class Watchman {
  #client: Client;

  #watch?: string;
  #relativePath?: string;

  constructor() {
    this.#client = new Client();
  }

  get client() {
    return this.#client;
  }

  check(): Promise<Partial<{ version: string }>> {
    return this.#client.capabilityCheck(
      {
        optional: [],
        required: [
          "relative_root",
          "cmd-watch-project",
          "wildmatch",
          "field-new",
        ],
      },
    );
  }

  command(...args: Parameters<Client["command"]>[0]) {
    return new Promise<never>((resolve, reject) => {
      this.#client.command(args, (error, resp) => {
        if (error) return reject(error);
        resolve(resp);
      });
    });
  }

  async watchProject(root: string) {
    try {
      const resp = await this.command("watch-project", root);

      const { watch, warning: _warning, relative_path } = resp;
      this.#watch = watch;
      this.#relativePath = relative_path;
    } catch (error) {
      console.error(error);
      return false;
    }
    return true;
  }

  async subscribe<T extends { root: string; files: string[] }>(
    sub: { [key: string]: unknown },
    cb: (resp: T) => void,
  ) {
    const uid = v4.generate();
    if (!sub.since) {
      const { clock } = await this.command("clock", this.#watch);
      sub = { since: clock, ...sub };
    }
    const { subscribe } = await this.command(
      "subscribe",
      this.#watch,
      uid,
      sub,
    );

    this.#client.on("subscription", (resp) => {
      if (!resp || resp.subscription != uid) return;
      const { files } = resp;
      if (!files || !files.length) return;

      cb({
        ...resp,
        root: this.#relativePath
          ? resolve(resp.root, this.#relativePath)
          : resp.root,
      });
    });

    return () => this.command("unsubscribe", this.#watch, subscribe);
  }

  end() {
    this.#client.removeAllListeners();
    this.#client.end();
  }
}
