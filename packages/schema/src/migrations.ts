/**
 * Read migrations — one up-only step per component version. The Action log and
 * stored row are never rewritten; coverage is checked at `defineSchema` time.
 */

import { assertComponentName } from "./model";

/** Transform a component's projected value from version `from` to `from + 1`. */
export type ComponentMigrationFn = (value: unknown) => unknown;

/** One declared read-migration step. */
export interface MigrationDef {
  readonly kind: "component-migration";
  /** Full `<model>/<leaf>` component name. */
  readonly component: string;
  readonly from: number;
  readonly to: number;
  readonly migrate: ComponentMigrationFn;
}

/** Raised when a `defineMigration` call is malformed. */
export class MigrationDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationDefinitionError";
  }
}

/** Raised when two steps claim the same `(component, fromVersion)` pair. */
export class DuplicateMigrationError extends Error {
  readonly component: string;
  readonly from: number;

  constructor(component: string, from: number) {
    super(
      `Component "${component}" declares two migrations from version ${from}. ` +
        `A version has one successor: remove one step.`,
    );
    this.name = "DuplicateMigrationError";
    this.component = component;
    this.from = from;
  }
}

/** Raised when migrations do not form one unbroken chain from version 1. */
export class MigrationChainError extends Error {
  readonly component: string;
  readonly version: number;
  readonly reason: "gap" | "overshoot" | "undeclared" | "unreachable";

  constructor(
    component: string,
    version: number,
    reason: MigrationChainError["reason"],
    detail: string,
  ) {
    super(`Migrations for component "${component}" are invalid at version ${version}: ${detail}`);
    this.name = "MigrationChainError";
    this.component = component;
    this.version = version;
    this.reason = reason;
  }
}

const keyOf = (component: string, from: number): string => `${component}\u0000${from}`;

/**
 * Declare one up step for a component's projected value:
 * `defineMigration("note/title", 1, 2, (value) => ({ title: value.name }))`.
 * Returning `undefined` projects as absent.
 */
export function defineMigration(
  component: string,
  from: number,
  to: number,
  migrate: ComponentMigrationFn,
): MigrationDef {
  assertComponentName(component);
  if (!Number.isInteger(from) || from < 1) {
    throw new MigrationDefinitionError(
      `Migration for "${component}" starts at version ${from}: a version is an integer >= 1.`,
    );
  }
  if (!Number.isInteger(to) || to <= from) {
    throw new MigrationDefinitionError(
      `Migration for "${component}" goes from ${from} to ${to}: a read migration moves up, ` +
        `so "to" must be a greater integer.`,
    );
  }
  if (typeof migrate !== "function") {
    throw new MigrationDefinitionError(
      `Migration for "${component}" from ${from} to ${to} has no function.`,
    );
  }
  return Object.freeze({ kind: "component-migration", component, from, to, migrate });
}

/** A component the schema declares, as far as migration coverage cares. */
export interface VersionedComponent {
  readonly name: string;
  readonly version: number;
}

/** The declared steps, validated against a component set at boot. */
export class MigrationRegistry {
  private readonly steps = new Map<string, MigrationDef>();
  private readonly chains = new Map<string, ComponentMigrationFn>();

  /** Add one step. Duplicate `(component, from)` pairs are refused. */
  register(def: MigrationDef): void {
    const key = keyOf(def.component, def.from);
    if (this.steps.has(key)) throw new DuplicateMigrationError(def.component, def.from);
    if (def.to <= def.from) {
      throw new MigrationDefinitionError(
        `Migration for "${def.component}" goes from ${def.from} to ${def.to}: it must move up.`,
      );
    }
    this.steps.set(key, def);
    this.chains.clear();
  }

  /** The step leaving `from`, or `undefined` when the chain has a gap. */
  get(component: string, from: number): MigrationDef | undefined {
    return this.steps.get(keyOf(component, from));
  }

  /** Every step declared for `component`, ordered by `from`. */
  stepsFor(component: string): readonly MigrationDef[] {
    return [...this.steps.values()]
      .filter((step) => step.component === component)
      .sort((a, b) => a.from - b.from);
  }

  /** Whether any step is declared for `component`. */
  has(component: string): boolean {
    return this.stepsFor(component).length > 0;
  }

  /** One component's steps from `from` up to `to`, in order. */
  chain(component: string, from: number, to: number): readonly MigrationDef[] {
    const out: MigrationDef[] = [];
    let version = from;
    while (version < to) {
      const step = this.get(component, version);
      if (step === undefined) {
        throw new MigrationChainError(
          component,
          version,
          "gap",
          `no migration leaves version ${version} for version ${to}.`,
        );
      }
      if (step.to > to) {
        throw new MigrationChainError(
          component,
          version,
          "overshoot",
          `version ${version} migrates to ${step.to}, past the declared version ${to}.`,
        );
      }
      out.push(step);
      version = step.to;
    }
    return out;
  }

  /** Apply the chain from `from` to `to`; a value already at `to` is unchanged. */
  migrate(component: string, from: number, to: number, value: unknown): unknown {
    if (from === to) return value;
    if (from > to) {
      throw new MigrationDefinitionError(
        `Migration for "${component}" cannot move backwards from ${from} to ${to}.`,
      );
    }
    const chain = this.chain(component, from, to);
    const key = `${keyOf(component, from)}>${to}`;
    let composed = this.chains.get(key);
    if (composed === undefined) {
      composed = (input: unknown): unknown =>
        chain.reduce<unknown>((current, step) => step.migrate(current), input);
      this.chains.set(key, composed);
    }
    return composed(value);
  }

  /** Boot check: every declared component has a complete chain from version 1. */
  validate(components: readonly VersionedComponent[]): void {
    const declared = new Map(components.map((component) => [component.name, component.version]));
    for (const step of this.steps.values()) {
      if (!declared.has(step.component)) {
        throw new MigrationChainError(
          step.component,
          step.from,
          "undeclared",
          `no model declares this component.`,
        );
      }
    }
    for (const component of components) {
      this.validateComponent(component, declared.get(component.name) ?? 1);
    }
  }

  private validateComponent(component: VersionedComponent, declaredVersion: number): void {
    const steps = this.stepsFor(component.name);
    if (steps.length === 0) {
      if (declaredVersion !== 1) {
        throw new MigrationChainError(
          component.name,
          declaredVersion,
          "gap",
          `the component declares version ${declaredVersion} but no migrations.`,
        );
      }
      return;
    }

    const visited = new Set<number>();
    let version = 1;
    while (version < declaredVersion) {
      visited.add(version);
      const step = this.get(component.name, version);
      if (step === undefined) {
        throw new MigrationChainError(
          component.name,
          version,
          "gap",
          `version ${declaredVersion} is declared but no migration leaves version ${version}.`,
        );
      }
      if (step.to > declaredVersion) {
        throw new MigrationChainError(
          component.name,
          version,
          "overshoot",
          `version ${version} migrates to ${step.to}, past the declared version ${declaredVersion}.`,
        );
      }
      version = step.to;
    }

    for (const step of steps) {
      if (step.from >= declaredVersion) {
        throw new MigrationChainError(
          component.name,
          step.from,
          "overshoot",
          `it starts at or past the declared version ${declaredVersion}.`,
        );
      }
      if (!visited.has(step.from)) {
        throw new MigrationChainError(
          component.name,
          step.from,
          "unreachable",
          `no chain from version 1 reaches it.`,
        );
      }
    }
  }
}
