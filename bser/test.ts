// deno-lint-ignore-file camelcase,no-explicit-any,no-inner-declarations
import {
  assertEquals,
  assertStrictEquals,
} from "https://deno.land/std@0.96.0/testing/asserts.ts";
import { Int64 } from "./int64.ts";
import * as bser from "./mod.ts";

Deno.test("loadFromBuffer", () => {
  // This is a hard-coded template representation from the C test suite
  const template = "\x00\x01\x03\x28" +
    "\x0b\x00\x03\x02\x02\x03\x04\x6e\x61\x6d\x65\x02" +
    "\x03\x03\x61\x67\x65\x03\x03\x02\x03\x04\x66\x72" +
    "\x65\x64\x03\x14\x02\x03\x04\x70\x65\x74\x65\x03" +
    "\x1e\x0c\x03\x19";

  const val = bser.loadFromBuffer(template);
  assertEquals(val, [
    { "name": "fred", "age": 20 },
    { "name": "pete", "age": 30 },
    { "age": 25 },
  ]);
});

Deno.test("roundtrip", () => {
  function roundtrip(val: any) {
    var encoded = bser.dumpToBuffer(val);
    var decoded = bser.loadFromBuffer(encoded);
    assertEquals(decoded, val);
  }

  var values_to_test = [
    1,
    "hello",
    1.5,
    false,
    true,
    new Int64("0x0123456789abcdef"),
    127,
    128,
    129,
    32767,
    32768,
    32769,
    65534,
    65536,
    65537,
    2147483647,
    2147483648,
    2147483649,
    null,
    [1, 2, 3],
    { foo: "bar" },
    { nested: { struct: "hello", list: [true, false, 1, "string"] } },
  ];

  for (var i = 0; i < values_to_test.length; ++i) {
    roundtrip(values_to_test[i]);
  }
  roundtrip(values_to_test);
});

Deno.test("Accumulator", () => {
  // Verify Accumulator edge cases
  const acc = new bser.Accumulator(8);
  acc.append("hello");
  assertStrictEquals(acc.readAvail(), 5);
  assertEquals(acc.readOffset, 0);
  assertEquals(acc.readString(3), "hel");
  assertEquals(acc.readOffset, 3);
  assertEquals(acc.readAvail(), 2);
  assertEquals(acc.writeAvail(), 3);

  // This should trigger a shunt and not make the buffer bigger
  acc.reserve(5);
  assertEquals(acc.readOffset, 0, "shunted");
  assertEquals(acc.readAvail(), 2, "still have 2 available to read");
  assertEquals(acc.writeAvail(), 6, "2 left to read out of 8 total space");
  assertEquals(acc.peekString(2), "lo", "have the correct remainder");
});

Deno.test("dumpToBuffer", () => {
  // Don't include keys that have undefined values
  const res = bser.dumpToBuffer({ expression: undefined });
  assertEquals(bser.loadFromBuffer(res), {});

  // Dump numbers without fraction to integers
  var buffer;
  buffer = bser.dumpToBuffer(1);
  assertEquals(buffer.toString("hex"), "000105020000000301");
  buffer = bser.dumpToBuffer(1.0);
  assertEquals(buffer.toString("hex"), "000105020000000301");

  // Dump numbers with fraction to double
  buffer = bser.dumpToBuffer(1.1);
  assertEquals(buffer.toString("hex"), "00010509000000079a9999999999f13f");
});
