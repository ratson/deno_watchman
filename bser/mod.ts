/* Copyright 2015-present Facebook, Inc.
 * Licensed under the Apache License, Version 2.0 */
// deno-lint-ignore-file
import { EventEmitter } from "https://deno.land/std@0.99.0/node/events.ts";
import os from "https://deno.land/std@0.99.0/node/os.ts";
import { Buffer } from "./deps.ts";
import { Int64 } from "./int64.ts";

// BSER uses the local endianness to reduce byte swapping overheads
// (the protocol is expressly local IPC only).  We need to tell node
// to use the native endianness when reading various native values.
const isBigEndian = os.endianness() == "BE";

// Find the next power-of-2 >= size
function nextPow2(size: number) {
  return Math.pow(2, Math.ceil(Math.log(size) / Math.LN2));
}

export class Accumulator {
  buf: ReturnType<typeof Buffer.alloc>;
  readOffset: number;
  writeOffset: number;

  constructor(initsize?: number) {
    this.buf = Buffer.alloc(nextPow2(initsize || 8192));

    this.readOffset = 0;
    this.writeOffset = 0;
  }

  // How much we can write into this buffer without allocating
  writeAvail() {
    return this.buf.length - this.writeOffset;
  }

  // How much we can read
  readAvail() {
    return this.writeOffset - this.readOffset;
  }

  // Ensure that we have enough space for size bytes
  reserve(size: number) {
    if (size < this.writeAvail()) {
      return;
    }

    // If we can make room by shunting down, do so
    if (this.readOffset > 0) {
      this.buf.copy(this.buf, 0, this.readOffset, this.writeOffset);
      this.writeOffset -= this.readOffset;
      this.readOffset = 0;
    }

    // If we made enough room, no need to allocate more
    if (size < this.writeAvail()) {
      return;
    }

    // Allocate a replacement and copy it in
    const buf = Buffer.alloc(
      nextPow2(this.buf.length + size - this.writeAvail()),
    );
    this.buf.copy(buf);
    this.buf = buf;
  }

  append(buf: Buffer | string) {
    if (Buffer.isBuffer(buf)) {
      this.reserve(buf.length);
      buf.copy(this.buf, this.writeOffset, 0, buf.length);
      this.writeOffset += buf.length;
    } else {
      const size = Buffer.byteLength(buf);
      this.reserve(size);
      this.buf.write(buf, this.writeOffset);
      this.writeOffset += size;
    }
  }

  assertReadableSize(size: number) {
    if (this.readAvail() < size) {
      throw new Error(
        "wanted to read " + size +
          " bytes but only have " + this.readAvail(),
      );
    }
  }

  peekString(size: number) {
    this.assertReadableSize(size);
    return this.buf.toString("utf-8", this.readOffset, this.readOffset + size);
  }

  readString(size: any) {
    var str = this.peekString(size);
    this.readOffset += size;
    return str;
  }

  peekInt(size: any) {
    this.assertReadableSize(size);
    switch (size) {
      case 1:
        return this.buf.readInt8(this.readOffset, size);
      case 2:
        return isBigEndian
          ? this.buf.readInt16BE(this.readOffset, size)
          : this.buf.readInt16LE(this.readOffset, size);
      case 4:
        return isBigEndian
          ? this.buf.readInt32BE(this.readOffset, size)
          : this.buf.readInt32LE(this.readOffset, size);
      case 8: {
        const big = this.buf.slice(this.readOffset, this.readOffset + 8);
        if (isBigEndian) {
          // On a big endian system we can simply pass the buffer directly
          return new Int64(big);
        }
        // Otherwise we need to byteswap
        return new Int64(byteswap64(big));
      }
      default:
        throw new Error("invalid integer size " + size);
    }
  }

  readInt(bytes: any) {
    var ival = this.peekInt(bytes);
    if (ival instanceof Int64 && isFinite(ival.valueOf())) {
      ival = ival.valueOf();
    }
    this.readOffset += bytes;
    return ival;
  }

  peekDouble() {
    this.assertReadableSize(8);
    return isBigEndian
      ? this.buf.readDoubleBE(this.readOffset)
      : this.buf.readDoubleLE(this.readOffset);
  }

  readDouble() {
    var dval = this.peekDouble();
    this.readOffset += 8;
    return dval;
  }

  readAdvance(size: any) {
    if (size > 0) {
      this.assertReadableSize(size);
    } else if (size < 0 && this.readOffset + size < 0) {
      throw new Error(
        "advance with negative offset " + size +
          " would seek off the start of the buffer",
      );
    }
    this.readOffset += size;
  }

  writeByte(value: any) {
    this.reserve(1);
    this.buf.writeInt8(value, this.writeOffset);
    ++this.writeOffset;
  }

  writeInt(value: any, size: any) {
    this.reserve(size);
    switch (size) {
      case 1:
        this.buf.writeInt8(value, this.writeOffset);
        break;
      case 2:
        if (isBigEndian) {
          this.buf.writeInt16BE(value, this.writeOffset);
        } else {
          this.buf.writeInt16LE(value, this.writeOffset);
        }
        break;
      case 4:
        if (isBigEndian) {
          this.buf.writeInt32BE(value, this.writeOffset);
        } else {
          this.buf.writeInt32LE(value, this.writeOffset);
        }
        break;
      default:
        throw new Error("unsupported integer size " + size);
    }
    this.writeOffset += size;
  }

  writeDouble(value: any) {
    this.reserve(8);
    if (isBigEndian) {
      this.buf.writeDoubleBE(value, this.writeOffset);
    } else {
      this.buf.writeDoubleLE(value, this.writeOffset);
    }
    this.writeOffset += 8;
  }
}

const BSER_ARRAY = 0x00;
const BSER_OBJECT = 0x01;
const BSER_STRING = 0x02;
const BSER_INT8 = 0x03;
const BSER_INT16 = 0x04;
const BSER_INT32 = 0x05;
const BSER_INT64 = 0x06;
const BSER_REAL = 0x07;
const BSER_TRUE = 0x08;
const BSER_FALSE = 0x09;
const BSER_NULL = 0x0a;
const BSER_TEMPLATE = 0x0b;
const BSER_SKIP = 0x0c;

const ST_NEED_PDU = 0; // Need to read and decode PDU length
const ST_FILL_PDU = 1; // Know the length, need to read whole content

const MAX_INT8 = 127;
const MAX_INT16 = 32767;
const MAX_INT32 = 2147483647;

export class BunserBuf extends EventEmitter {
  buf: Accumulator;
  state: any;
  pduLen: any;

  constructor() {
    super();

    this.buf = new Accumulator();
    this.state = ST_NEED_PDU;
  }

  append(buf: Buffer, synchronous?: any) {
    if (synchronous) {
      this.buf.append(buf);
      return this.process(synchronous);
    }

    try {
      this.buf.append(buf);
    } catch (err) {
      this.emit("error", err);
      return;
    }
    // Arrange to decode later.  This allows the consuming
    // application to make progress with other work in the
    // case that we have a lot of subscription updates coming
    // in from a large tree.
    this.processLater();
  }

  processLater() {
    setTimeout(() => {
      try {
        this.process(false);
      } catch (err) {
        this.emit("error", err);
      }
    }, 0);
  }

  // Do something with the buffer to advance our state.
  // If we're running synchronously we'll return either
  // the value we've decoded or undefined if we don't
  // yet have enought data.
  // If we're running asynchronously, we'll emit the value
  // when it becomes ready and schedule another invocation
  // of process on the next tick if we still have data we
  // can process.
  process(synchronous: any) {
    if (this.state == ST_NEED_PDU) {
      if (this.buf.readAvail() < 2) {
        return;
      }
      // Validate BSER header
      this.expectCode(0);
      this.expectCode(1);
      this.pduLen = this.decodeInt(true /* relaxed */);
      if (this.pduLen === false) {
        // Need more data, walk backwards
        this.buf.readAdvance(-2);
        return;
      }
      // Ensure that we have a big enough buffer to read the rest of the PDU
      this.buf.reserve(this.pduLen);
      this.state = ST_FILL_PDU;
    }

    if (this.state == ST_FILL_PDU) {
      if (this.buf.readAvail() < this.pduLen) {
        // Need more data
        return;
      }

      // We have enough to decode it
      var val = this.decodeAny();
      if (synchronous) {
        return val;
      }
      this.emit("value", val);
      this.state = ST_NEED_PDU;
    }

    if (!synchronous && this.buf.readAvail() > 0) {
      this.processLater();
    }
  }

  raise(reason: any) {
    throw new Error(
      reason + ", in Buffer of length " +
        this.buf.buf.length + " (" + this.buf.readAvail() +
        " readable) at offset " + this.buf.readOffset + " buffer: " +
        JSON.stringify(
          this.buf.buf.slice(
            this.buf.readOffset,
            this.buf.readOffset + 32,
          ).toJSON(),
        ),
    );
  }

  expectCode(expected: any) {
    var code = this.buf.readInt(1);
    if (code != expected) {
      this.raise("expected bser opcode " + expected + " but got " + code);
    }
  }

  decodeAny() {
    var code = this.buf.peekInt(1);
    switch (code) {
      case BSER_INT8:
      case BSER_INT16:
      case BSER_INT32:
      case BSER_INT64:
        return this.decodeInt();
      case BSER_REAL:
        this.buf.readAdvance(1);
        return this.buf.readDouble();
      case BSER_TRUE:
        this.buf.readAdvance(1);
        return true;
      case BSER_FALSE:
        this.buf.readAdvance(1);
        return false;
      case BSER_NULL:
        this.buf.readAdvance(1);
        return null;
      case BSER_STRING:
        return this.decodeString();
      case BSER_ARRAY:
        return this.decodeArray();
      case BSER_OBJECT:
        return this.decodeObject();
      case BSER_TEMPLATE:
        return this.decodeTemplate();
      default:
        this.raise("unhandled bser opcode " + code);
    }
  }

  decodeArray(): any {
    this.expectCode(BSER_ARRAY);
    var nitems = this.decodeInt();
    var arr = [];
    for (var i = 0; i < nitems; ++i) {
      arr.push(this.decodeAny());
    }
    return arr;
  }

  decodeObject() {
    this.expectCode(BSER_OBJECT);
    var nitems = this.decodeInt();
    var res: { [k: string]: any } = {};
    for (var i = 0; i < nitems; ++i) {
      var key = this.decodeString();
      var val = this.decodeAny();
      res[key] = val;
    }
    return res;
  }

  decodeTemplate() {
    this.expectCode(BSER_TEMPLATE);
    var keys = this.decodeArray();
    var nitems = this.decodeInt();
    var arr = [];
    for (var i = 0; i < nitems; ++i) {
      var obj: { [k: string]: any } = {};
      for (var keyidx = 0; keyidx < keys.length; ++keyidx) {
        if (this.buf.peekInt(1) == BSER_SKIP) {
          this.buf.readAdvance(1);
          continue;
        }
        var val = this.decodeAny();
        obj[keys[keyidx]] = val;
      }
      arr.push(obj);
    }
    return arr;
  }

  decodeString() {
    this.expectCode(BSER_STRING);
    var len = this.decodeInt();
    return this.buf.readString(len);
  }

  // This is unusual compared to the other decode functions in that
  // we may not have enough data available to satisfy the read, and
  // we don't want to throw.  This is only true when we're reading
  // the PDU length from the PDU header; we'll set relaxSizeAsserts
  // in that case.
  decodeInt(relaxSizeAsserts?: any) {
    if (relaxSizeAsserts && (this.buf.readAvail() < 1)) {
      return false;
    } else {
      this.buf.assertReadableSize(1);
    }
    var code = this.buf.peekInt(1);
    var size = 0;
    switch (code) {
      case BSER_INT8:
        size = 1;
        break;
      case BSER_INT16:
        size = 2;
        break;
      case BSER_INT32:
        size = 4;
        break;
      case BSER_INT64:
        size = 8;
        break;
      default:
        this.raise("invalid bser int encoding " + code);
    }

    if (relaxSizeAsserts && (this.buf.readAvail() < 1 + size)) {
      return false;
    }
    this.buf.readAdvance(1);
    return this.buf.readInt(size);
  }
}

// synchronously BSER decode a string and return the value
export function loadFromBuffer(input: any) {
  var buf = new BunserBuf();
  var result = buf.append(input, true);
  if (buf.buf.readAvail()) {
    throw Error(
      "excess data found after input buffer, use BunserBuf instead",
    );
  }
  if (typeof result === "undefined") {
    throw Error(
      "no bser found in string and no error raised!?",
    );
  }
  return result;
}

// Byteswap an arbitrary buffer, flipping from one endian
// to the other, returning a new buffer with the resultant data
function byteswap64(buf: any) {
  var swap = Buffer.alloc(buf.length);
  for (var i = 0; i < buf.length; i++) {
    swap[i] = buf[buf.length - 1 - i];
  }
  return swap;
}

function dump_int64(buf: any, val: any) {
  // Get the raw bytes.  The Int64 buffer is big endian
  var be = val.toBuffer();

  if (isBigEndian) {
    // We're a big endian system, so the buffer is exactly how we
    // want it to be
    buf.writeByte(BSER_INT64);
    buf.append(be);
    return;
  }
  // We need to byte swap to get the correct representation
  var le = byteswap64(be);
  buf.writeByte(BSER_INT64);
  buf.append(le);
}

function dump_int(buf: any, val: any) {
  var abs = Math.abs(val);
  if (abs <= MAX_INT8) {
    buf.writeByte(BSER_INT8);
    buf.writeInt(val, 1);
  } else if (abs <= MAX_INT16) {
    buf.writeByte(BSER_INT16);
    buf.writeInt(val, 2);
  } else if (abs <= MAX_INT32) {
    buf.writeByte(BSER_INT32);
    buf.writeInt(val, 4);
  } else {
    dump_int64(buf, new Int64(val));
  }
}

function dump_any(buf: any, val: any) {
  switch (typeof (val)) {
    case "number":
      // check if it is an integer or a float
      if (isFinite(val) && Math.floor(val) === val) {
        dump_int(buf, val);
      } else {
        buf.writeByte(BSER_REAL);
        buf.writeDouble(val);
      }
      return;
    case "string":
      buf.writeByte(BSER_STRING);
      dump_int(buf, Buffer.byteLength(val));
      buf.append(val);
      return;
    case "boolean":
      buf.writeByte(val ? BSER_TRUE : BSER_FALSE);
      return;
    case "object":
      if (val === null) {
        buf.writeByte(BSER_NULL);
        return;
      }
      if (val instanceof Int64) {
        dump_int64(buf, val);
        return;
      }
      if (Array.isArray(val)) {
        buf.writeByte(BSER_ARRAY);
        dump_int(buf, val.length);
        for (var i = 0; i < val.length; ++i) {
          dump_any(buf, val[i]);
        }
        return;
      }
      buf.writeByte(BSER_OBJECT);
      var keys = Object.keys(val);

      // First pass to compute number of defined keys
      var num_keys = keys.length;
      for (var i = 0; i < keys.length; ++i) {
        var key = keys[i];
        var v = val[key];
        if (typeof (v) == "undefined") {
          num_keys--;
        }
      }
      dump_int(buf, num_keys);
      for (var i = 0; i < keys.length; ++i) {
        var key = keys[i];
        var v = val[key];
        if (typeof (v) == "undefined") {
          // Don't include it
          continue;
        }
        dump_any(buf, key);
        try {
          dump_any(buf, v);
        } catch (e) {
          throw new Error(
            e.message + " (while serializing object property with name `" +
              key + "')",
          );
        }
      }
      return;

    default:
      throw new Error("cannot serialize type " + typeof (val) + " to BSER");
  }
}

// BSER encode value and return a buffer of the contents
export function dumpToBuffer(val: any) {
  var buf = new Accumulator();
  // Build out the header
  buf.writeByte(0);
  buf.writeByte(1);
  // Reserve room for an int32 to hold our PDU length
  buf.writeByte(BSER_INT32);
  buf.writeInt(0, 4); // We'll come back and fill this in at the end

  dump_any(buf, val);

  // Compute PDU length
  var off = buf.writeOffset;
  var len = off - 7 /* the header length */;
  buf.writeOffset = 3; // The length value to fill in
  buf.writeInt(len, 4); // write the length in the space we reserved
  buf.writeOffset = off;

  return buf.buf.slice(0, off);
}
