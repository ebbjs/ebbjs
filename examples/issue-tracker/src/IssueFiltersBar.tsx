/**
 * Filter controls for the issue query. Every selection is a predicate the
 * panel passes to `buildIssueQuery`, so filtering happens in the replica
 * rather than by hiding rows after the read.
 */

import { SelectField } from "./SelectField";
import {
  PRIORITY_FILTER_OPTIONS,
  STATUS_FILTER_OPTIONS,
  assigneeFilterOptions,
} from "./issue-options";
import { hasActiveFilters, type IssueFilters } from "./issue-view";

export function IssueFiltersBar({
  filters,
  profiles,
  onChange,
}: {
  filters: IssueFilters;
  profiles: readonly { id: string; display_name: string; actor_id: string }[];
  onChange: (next: IssueFilters) => void;
}) {
  const set = (patch: Partial<IssueFilters>): void => {
    onChange({ ...filters, ...patch });
  };

  return (
    <div className="mb-3 flex flex-wrap items-end gap-2" data-testid="issue-filters">
      <SelectField
        label="status"
        value={filters.status}
        onChange={(status) => set({ status })}
        options={STATUS_FILTER_OPTIONS}
      />
      <SelectField
        label="priority"
        value={filters.priority}
        onChange={(priority) => set({ priority })}
        options={PRIORITY_FILTER_OPTIONS}
      />
      <SelectField
        label="assignee"
        value={filters.assignee}
        onChange={(assignee) => set({ assignee })}
        options={assigneeFilterOptions(profiles)}
      />
      <button
        type="button"
        onClick={() => onChange({ status: "", priority: "", assignee: "" })}
        disabled={!hasActiveFilters(filters)}
        className="rounded border border-stone-700 px-2 py-1 font-mono text-xs text-stone-400 hover:border-stone-500 disabled:cursor-not-allowed disabled:opacity-40"
      >
        clear
      </button>
    </div>
  );
}
