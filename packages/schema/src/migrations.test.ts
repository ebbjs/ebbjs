/**
 * Per-component read migrations (#804): a declaration is valid only when the
 * chain from version 1 reaches the component's declared version.
 */

import { describe, expect, it } from "vitest";

import { e, defineComponent, defineModel, InvalidComponentVersionError } from "./model";
import { MigrationDefinitionError, defineMigration } from "./migrations";
import { defineSchema } from "./schema";

const title = (version = 1) => defineComponent("note/title", e.string(), { version });

const rename = (from: number, to: number) =>
  defineMigration("note/title", from, to, (value) => ({ name: value }));

const schemaWith = (version: number, migrations = [rename(1, version)]) =>
  defineSchema({
    models: { note: defineModel("note", { title: title(version) }) },
    version: 1,
    migrations,
  });

describe("defineMigration", () => {
  it("refuses a component name that is not <model>/<leaf>", () => {
    expect(() => defineMigration("title", 1, 2, (value) => value)).toThrow(
      /must be "<model>\/<leaf>"/,
    );
  });

  it("refuses a non-integer or non-positive from version", () => {
    expect(() => defineMigration("note/title", 0, 2, (v) => v)).toThrow(MigrationDefinitionError);
    expect(() => defineMigration("note/title", 1.5, 2, (v) => v)).toThrow(MigrationDefinitionError);
  });

  it("refuses a step that does not move up", () => {
    expect(() => defineMigration("note/title", 2, 2, (v) => v)).toThrow(/moves up/);
    expect(() => defineMigration("note/title", 3, 2, (v) => v)).toThrow(MigrationDefinitionError);
  });

  it("refuses a missing function", () => {
    expect(() =>
      defineMigration("note/title", 1, 2, undefined as unknown as (v: unknown) => unknown),
    ).toThrow(/has no function/);
  });
});

describe("defineComponent version", () => {
  it("defaults to version 1", () => {
    expect(defineComponent("note/title", e.string()).version).toBe(1);
  });

  it("refuses a version that is not an integer >= 1", () => {
    expect(() => title(0)).toThrow(InvalidComponentVersionError);
    expect(() => title(1.5)).toThrow(InvalidComponentVersionError);
  });
});

describe("defineSchema migration validation", () => {
  it("accepts a component at version 1 with no migrations", () => {
    expect(() =>
      defineSchema({ models: { note: defineModel("note", { title: e.string() }) }, version: 1 }),
    ).not.toThrow();
  });

  it("accepts a complete chain to the declared version", () => {
    expect(() => schemaWith(3, [rename(1, 2), rename(2, 3)])).not.toThrow();
  });

  it("fails at boot for a component version with no migration", () => {
    expect(() => schemaWith(2, [])).toThrow(/version 2 but no migrations/);
  });

  it("fails at boot for a gap in the chain", () => {
    expect(() => schemaWith(3, [rename(1, 2)])).toThrow(/no migration leaves version 2/);
  });

  it("fails at boot for a chain that does not start at version 1", () => {
    expect(() => schemaWith(3, [rename(2, 3)])).toThrow(/no migration leaves version 1/);
  });

  it("fails at boot for a step past the declared version", () => {
    expect(() => schemaWith(2, [rename(1, 2), rename(2, 3)])).toThrow(
      /starts at or past the declared version 2/,
    );
  });

  it("fails at boot for two migrations leaving the same version", () => {
    expect(() => schemaWith(2, [rename(1, 2), rename(1, 2)])).toThrow(
      /declares two migrations from version 1/,
    );
  });

  it("fails at boot for a migration on an undeclared component", () => {
    expect(() =>
      defineSchema({
        models: { note: defineModel("note", { title: e.string() }) },
        version: 1,
        migrations: [defineMigration("other/title", 1, 2, (value) => value)],
      }),
    ).toThrow(/no model declares this component/);
  });
});
