import { describe, expect, it } from "vitest";
import { issue, profile, schema } from "../schema";

describe("issue-tracker schema", () => {
  it("declares no scalar assignee_id on the issue", () => {
    expect(Object.keys(issue.shape.properties ?? {})).not.toContain("assignee_id");
    expect(Object.keys(issue.shape.properties ?? {}).sort()).toEqual([
      "priority",
      "status",
      "title",
    ]);
  });

  it("declares the assignee as a forward-one relationship to profile", () => {
    const relationship = schema._registry.getRelationship("issue", "assignee");
    expect(relationship).toBeDefined();
    expect(relationship?.target.name).toBe(profile.name);
    expect(relationship?.sourceCardinality).toBe("one");
  });
});
