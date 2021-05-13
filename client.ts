/* Copyright 2014-present Facebook, Inc.
 * Licensed under the Apache License, Version 2.0 */
// deno-lint-ignore-file no-explicit-any,camelcase
import { EventEmitter } from "https://deno.land/std@0.96.0/node/events.ts";
import { iter } from "https://deno.land/std@0.96.0/io/util.ts";
import { Buffer } from "./bser/deps.ts";
import * as bser from "./bser/mod.ts";

// We'll emit the responses to these when they get sent down to us
const unilateralTags = ["subscription", "log"] as const;

const cap_versions = {
  "cmd-watch-del-all": "3.1.1",
  "cmd-watch-project": "3.1",
  relative_root: "3.3",
  "term-dirname": "3.1",
  "term-idirname": "3.1",
  wildmatch: "3.7",
} as const;

// Compares a vs b, returns < 0 if a < b, > 0 if b > b, 0 if a == b
function vers_compare(a: string, b: string) {
  const s = a.split(".");
  const t = b.split(".");
  for (let i = 0; i < 3; i++) {
    const d = parseInt(s[i] || "0") - parseInt(t[i] || "0");
    if (d != 0) {
      return d;
    }
  }
  return 0; // Equal
}

function have_cap(vers: any, name: string) {
  if (name in cap_versions) {
    return vers_compare(
      vers,
      cap_versions[name as keyof typeof cap_versions],
    ) >= 0;
  }
  return false;
}

type Command = { cmd: any; cb: (error?: Error | null, resp?: any) => any };

export class Client extends EventEmitter {
  watchmanBinaryPath: string;
  commands: Command[];

  currentCommand?: Command | null;
  bunser?: bser.BunserBuf | null;
  socket?: Deno.Conn | null;
  connecting?: boolean;

  constructor(options?: { watchmanBinaryPath?: string }) {
    super();

    this.watchmanBinaryPath = "watchman";
    if (options && options.watchmanBinaryPath) {
      this.watchmanBinaryPath = options.watchmanBinaryPath.trim();
    }
    this.commands = [];
  }

  // Try to send the next queued command, if any
  sendNextCommand() {
    if (this.currentCommand) {
      // There's a command pending response, don't send this new one yet
      return;
    }

    this.currentCommand = this.commands.shift();
    if (!this.currentCommand) {
      // No further commands are queued
      return;
    }

    this.socket!.write(bser.dumpToBuffer(this.currentCommand.cmd));
  }

  cancelCommands(why: string) {
    var error = new Error(why);

    // Steal all pending commands before we start cancellation, in
    // case something decides to schedule more commands
    var cmds = this.commands;
    this.commands = [];

    if (this.currentCommand) {
      cmds.unshift(this.currentCommand);
      this.currentCommand = null;
    }

    // Synthesize an error condition for any commands that were queued
    cmds.forEach(function (cmd) {
      cmd.cb(error);
    });
  }

  async connect() {
    const makeSock = async (sockname: string) => {
      // bunser will decode the watchman BSER protocol for us
      this.bunser = new bser.BunserBuf();
      // For each decoded line:
      this.bunser.on("value", (obj) => {
        // Figure out if this is a unliteral response or if it is the
        // response portion of a request-response sequence.  At the time
        // of writing, there are only two possible unilateral responses.
        var unilateral: boolean | string = false;
        for (let i = 0; i < unilateralTags.length; i++) {
          const tag = unilateralTags[i];
          if (tag in obj) {
            unilateral = tag;
          }
        }

        if (unilateral) {
          this.emit(unilateral, obj);
        } else if (this.currentCommand) {
          const cmd = this.currentCommand;
          this.currentCommand = null;
          if ("error" in obj) {
            const error = new Error(obj.error);
            // @ts-expect-error dynamic prop
            error.watchmanResponse = obj;
            cmd.cb(error);
          } else {
            cmd.cb(null, obj);
          }
        }

        // See if we can dispatch the next queued command, if any
        this.sendNextCommand();
      });
      this.bunser.on("error", (err) => {
        this.emit("error", err);
      });

      try {
        this.socket = await Deno.connect({ path: sockname, transport: "unix" });
        this.connecting = false;
        this.emit("connect");
        this.sendNextCommand();

        for await (const buf of iter(this.socket, { bufSize: 1024 })) {
          if (this.bunser) {
            this.bunser.append(Buffer.from(buf));
          }
        }
      } catch (err) {
        this.connecting = false;
        if (err.message !== "operation canceled") {
          this.emit("error", err);
        }
      } finally {
        this.socket = null;
        this.bunser = null;
        this.cancelCommands("The watchman connection was closed");
        this.emit("end");
      }
    };

    // triggers will export the sock path to the environment.
    // If we're invoked in such a way, we can simply pick up the
    // definition from the environment and avoid having to fork off
    // a process to figure it out
    if (Deno.env.get("WATCHMAN_SOCK")) {
      await makeSock(Deno.env.get("WATCHMAN_SOCK")!);
      return;
    }

    // We need to ask the client binary where to find it.
    // This will cause the service to start for us if it isn't
    // already running.
    const args = ["--no-pretty", "get-sockname"];

    // We use the more elaborate spawn rather than exec because there
    // are some error cases on Windows where process spawning can hang.
    // It is desirable to pipe stderr directly to stderr live so that
    // we can discover the problem.
    // const proc = null;
    let spawnFailed = false;

    const spawnError = (error: any) => {
      if (spawnFailed) {
        // For ENOENT, proc 'close' will also trigger with a negative code,
        // let's suppress that second error.
        return;
      }
      spawnFailed = true;
      if (error.code === "EACCES" || error.errno === "EACCES") {
        error.message = "The Watchman CLI is installed but cannot " +
          "be spawned because of a permission problem";
      } else if (error.code === "ENOENT" || error.errno === "ENOENT") {
        error.message = "Watchman was not found in PATH.  See " +
          "https://facebook.github.io/watchman/docs/install.html " +
          "for installation instructions";
      }
      console.error("Watchman: ", error.message);
      this.emit("error", error);
    };

    const proc = Deno.run({
      cmd: [this.watchmanBinaryPath, ...args],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    });
    const s = await proc.status();
    if (!s.success) {
      const stderrBytes = await proc.stderrOutput();
      spawnError(
        new Error(
          this.watchmanBinaryPath +
            " " +
            args.join(" ") +
            " returned with exit code=" +
            s.code +
            ", signal=" +
            s.signal +
            ", stderr= " +
            new TextDecoder().decode(stderrBytes),
        ),
      );
      return;
    }

    try {
      const stdoutBytes = await proc.output();
      const obj = JSON.parse(new TextDecoder().decode(stdoutBytes));
      if ("error" in obj) {
        const error = new Error(obj.error);
        // @ts-expect-error dynamic prop
        error.watchmanResponse = obj;
        this.emit("error", error);
        return;
      }
      await makeSock(obj.sockname);
    } catch (e) {
      this.emit("error", e);
    }

    proc.close();
  }

  command(args: Command["cmd"], done: Command["cb"]) {
    done = done || function () {};

    // Queue up the command
    this.commands.push({ cmd: args, cb: done });

    // Establish a connection if we don't already have one
    if (!this.socket) {
      if (!this.connecting) {
        this.connecting = true;
        this.connect();
        return;
      }
      return;
    }

    // If we're already connected and idle, try sending the command immediately
    this.sendNextCommand();
  }

  private _synthesizeCapabilityCheck(
    resp: any,
    optional: string[],
    required: string[],
  ) {
    resp.capabilities = {};
    const version = resp.version;
    optional.forEach(function (name: string) {
      resp.capabilities[name] = have_cap(version, name);
    });
    required.forEach(function (name: string) {
      var have = have_cap(version, name);
      resp.capabilities[name] = have;
      if (!have) {
        resp.error =
          `client required capability \`${name}\` is not supported by this server`;
      }
    });
    return resp;
  }

  capabilityCheck(caps: { optional?: string[]; required?: string[] }) {
    const optional = caps.optional || [];
    const required = caps.required || [];
    return new Promise<
      { version: string; capabilities: { [key: string]: boolean } }
    >((resolve, reject) => {
      this.command(
        ["version", { optional, required }],
        (error, resp) => {
          if (error) {
            reject(error);
            return;
          }
          if (!("capabilities" in resp)) {
            // Server doesn't support capabilities, so we need to
            // synthesize the results based on the version
            resp = this._synthesizeCapabilityCheck(resp, optional, required);
            if (resp.error) {
              error = new Error(resp.error);
              // @ts-expect-error dynamic prop
              error.watchmanResponse = resp;
              reject(error);
              return;
            }
          }
          resolve(resp);
        },
      );
    });
  }

  end() {
    this.cancelCommands("The client was ended");
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.bunser = null;
  }
}
