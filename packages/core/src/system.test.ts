/**
 * The platform component readers: the three atomic values, and the keyed
 * `ebb/link` component whose nesting is the edge's key.
 */

import { describe, expect, it } from "vitest";

import {
  carriesComponent,
  carriesLink,
  linkEdges,
  linkTargets,
  systemValue,
  systemValueString,
  type FieldValue,
} from "./index";

/** A wire leaf: presence is `true`, a removal a `null` tombstone. */
const leaf = (value: unknown): FieldValue => ({ value, update_id: "u_1", hlc: "1" });

/** An `ebb/link` value from `{<as>: {<type>: {<target>: true | null}}}`. */
const links = (
  value: Record<string, Record<string, Record<string, boolean | null>>>,
): FieldValue => ({
  map: Object.fromEntries(
    Object.entries(value).map(([as, byType]) => [
      as,
      {
        map: Object.fromEntries(
          Object.entries(byType).map(([type, byTarget]) => [
            type,
            {
              map: Object.fromEntries(
                Object.entries(byTarget).map(([id, present]) => [id, leaf(present ? true : null)]),
              ),
            },
          ]),
        ),
      },
    ]),
  ),
});

const row = (link: FieldValue | undefined): { data: { fields: Record<string, FieldValue> } } => ({
  data: { fields: link === undefined ? {} : { link } },
});

describe("ebb/link readers", () => {
  it("lists the live edges in a stable order and skips tombstones", () => {
    const source = row(
      links({
        project: { issue: { e_p1: true } },
        labels: { issue: { e_l2: true, e_l1: true, e_gone: null } },
      }),
    );

    expect(linkEdges(source)).toEqual([
      { as: "labels", type: "issue", targetId: "e_l1" },
      { as: "labels", type: "issue", targetId: "e_l2" },
      { as: "project", type: "issue", targetId: "e_p1" },
    ]);
  });

  it("reads the targets of one accessor and type", () => {
    const source = row(
      links({
        labels: { issue: { e_l2: true, e_l1: true, e_gone: null } },
        project: { issue: { e_p1: true } },
      }),
    );

    expect(linkTargets(source, "labels", "issue")).toEqual(["e_l1", "e_l2"]);
    expect(linkTargets(source, "project", "issue")).toEqual(["e_p1"]);
    // A type label separates edges that share an accessor.
    expect(linkTargets(source, "labels", "label")).toEqual([]);
  });

  it("reads a row with no link component as no edges", () => {
    expect(linkEdges(null)).toEqual([]);
    expect(linkEdges(row(undefined))).toEqual([]);
    expect(linkTargets(row(undefined), "labels", "issue")).toEqual([]);
    expect(carriesLink(row(undefined))).toBe(false);
  });

  it("tells a component apart from a whole value", () => {
    const source = row(links({ project: { issue: { e_p1: true } } }));

    expect(carriesLink(source)).toBe(true);
    // A keyed component has no whole value, so the atomic readers say so
    // rather than answering with the nest of maps.
    expect(systemValue(source, "link")).toBeNull();
    expect(systemValueString(source, "link", "source_id")).toBeNull();
    expect(carriesComponent(source, "link")).toBe(false);
  });

  it("still reads an atomic component's value", () => {
    const grant = {
      data: {
        fields: {
          grant: leaf({ actor_id: "a_1", group_id: "g_1", permissions: ["ebb.*"] }),
        },
      },
    };

    expect(systemValueString(grant, "grant", "group_id")).toBe("g_1");
    expect(carriesComponent(grant, "grant")).toBe(true);
  });
});
