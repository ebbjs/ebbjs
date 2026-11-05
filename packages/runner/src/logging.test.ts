import { describe, expect, it, vi } from "vitest";

import type { LogEntry } from "@ebbjs/functions-runtime";

import {
  captureConsole,
  createLogSink,
  formatArgs,
  formatValue,
  LOG_TRUNCATION_NOTICE,
} from "./logging.ts";

const sinkWith = (options: { maxLines?: number; maxBytes?: number } = {}) => {
  const entries: LogEntry[] = [];
  const sink = createLogSink({
    send: (entry) => entries.push(entry),
    maxLines: options.maxLines ?? 200,
    maxBytes: options.maxBytes ?? 65_536,
  });
  return { entries, sink };
};

const line = (message: string, level: LogEntry["level"] = "info"): LogEntry => ({ level, message });

describe("createLogSink", () => {
  it("forwards a line under the budget", () => {
    const { entries, sink } = sinkWith();

    sink.log(line("hello", "warn"));

    expect(entries).toEqual([line("hello", "warn")]);
    expect(sink.truncated).toBe(false);
  });

  it("drops past the line cap and sends one truncation notice", () => {
    const { entries, sink } = sinkWith({ maxLines: 2 });

    for (const message of ["one", "two", "three", "four", "five"]) sink.log(line(message));

    expect(entries.map((entry) => entry.message)).toEqual(["one", "two", LOG_TRUNCATION_NOTICE]);
    expect(entries[2]?.level).toBe("warn");
    expect(sink.truncated).toBe(true);
  });

  it("counts message bytes across the invocation", () => {
    const { entries, sink } = sinkWith({ maxBytes: 8 });

    sink.log(line("abcd"));
    sink.log(line("efgh"));
    sink.log(line("i"));

    expect(entries.map((entry) => entry.message)).toEqual(["abcd", "efgh", LOG_TRUNCATION_NOTICE]);
  });

  it("does not send a line that alone exceeds the byte cap", () => {
    const { entries, sink } = sinkWith({ maxBytes: 4 });

    sink.log(line("too long"));

    expect(entries.map((entry) => entry.message)).toEqual([LOG_TRUNCATION_NOTICE]);
  });

  it("drops silently after the truncation notice", () => {
    const { entries, sink } = sinkWith({ maxLines: 1 });

    sink.log(line("kept"));
    sink.log(line("dropped"));
    const afterNotice = entries.length;
    sink.log(line("also dropped"));

    expect(afterNotice).toBe(2);
    expect(entries).toHaveLength(2);
  });

  it("drops everything after the invocation closes", () => {
    const { entries, sink } = sinkWith();

    sink.close();
    sink.log(line("late"));

    expect(entries).toEqual([]);
  });

  it("does not throw when the transport's send throws", () => {
    const sink = createLogSink({
      send: () => {
        throw new Error("socket gone");
      },
      maxLines: 10,
      maxBytes: 100,
    });

    expect(() => sink.log(line("hello"))).not.toThrow();
  });
});

describe("formatValue", () => {
  it("stringifies anything a handler may print", () => {
    expect(formatValue("text")).toBe("text");
    expect(formatValue(42)).toBe("42");
    expect(formatValue(undefined)).toBe("undefined");
    expect(formatValue(null)).toBe("null");
    expect(formatValue({ a: 1 })).toBe('{"a":1}');
    expect(formatValue(Symbol("s"))).toBe("Symbol(s)");
    expect(formatValue(7n)).toBe("7n");
    expect(formatValue(new Error("boom"))).toBe("Error: boom");
    expect(formatValue([1, 2])).toBe("[1,2]");
  });

  it("survives a circular object and a throwing toString", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(formatValue(circular)).toBe("[object Object]");

    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, "boom", {
      enumerable: true,
      get() {
        throw new Error("no json");
      },
    });
    Object.defineProperty(hostile, "toString", {
      value: () => {
        throw new Error("no string");
      },
    });
    expect(formatValue(hostile)).toBe("[unprintable]");
  });

  it("joins arguments with a space", () => {
    expect(formatArgs(["hello", 42, { a: 1 }])).toBe('hello 42 {"a":1}');
  });
});

describe("captureConsole", () => {
  it("sends each captured call as a log entry and restores the originals", () => {
    const entries: LogEntry[] = [];
    const originals = {
      debug: console.debug,
      info: console.info,
      log: console.log,
      warn: console.warn,
      error: console.error,
    };

    const restore = captureConsole((entry) => entries.push(entry));

    console.debug("d");
    console.info("i");
    console.log("l", 1);
    console.warn("w");
    console.error(new Error("e"));

    restore();

    expect(entries).toEqual([
      { level: "debug", message: "d" },
      { level: "info", message: "i" },
      { level: "log", message: "l 1" },
      { level: "warn", message: "w" },
      { level: "error", message: "Error: e" },
    ]);
    expect(console.debug).toBe(originals.debug);
    expect(console.info).toBe(originals.info);
    expect(console.log).toBe(originals.log);
    expect(console.warn).toBe(originals.warn);
    expect(console.error).toBe(originals.error);
  });

  it("does not reimplement other console methods", () => {
    const table = vi.spyOn(console, "table").mockImplementation(() => undefined);
    const restore = captureConsole(() => undefined);

    console.table([1, 2]);

    restore();
    expect(table).toHaveBeenCalledOnce();
    table.mockRestore();
  });

  it("never throws when the sink throws", () => {
    const restore = captureConsole(() => {
      throw new Error("sink down");
    });

    expect(() => console.log("hello")).not.toThrow();
    restore();
  });
});
