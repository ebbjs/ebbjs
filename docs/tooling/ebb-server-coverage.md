# ebb_server coverage

`mix test --cover` prints a line-coverage summary and writes an HTML report to
`ebb_server/cover/`, which is git-ignored. CI runs it as part of the Test job,
so the summary total is a gate, not a report nobody reads.

## Running it locally

```bash
cd ebb_server
mix test --cover
```

The tail of the output is the per-module table and a `Total` line; the gate is
that total. `cover/Elixir.<Module>.html` marks the missed lines for one module,
e.g. `cover/Elixir.EbbServer.Storage.Writer.html`. A run under the threshold
also prints the total and threshold, and exits with status **3** — Elixir's
coverage task uses `exit({:shutdown, 3})`, not the status 1 that `mix test`'s
own docs suggest. Any non-zero status fails the CI step.

The report directory is not cleaned between runs, so `rm -rf cover` after
changing the ignore list; otherwise the HTML for newly ignored modules stays
behind and the glob above picks up stale files.

## What the number counts

The denominator is the server's own modules minus the ignore list below.
`test_coverage` in `ebb_server/mix.exs` drops the code that only exists to
exercise or demonstrate the server:

| Ignored                                 | Why                                                      |
| --------------------------------------- | -------------------------------------------------------- |
| `EbbServer.Bench.*`                     | benchmark scaffolding, never shipped                     |
| `Mix.Tasks.*`                           | dev/bench/openapi task entry points                      |
| `EbbServer.TestHelpers`                 | test support, compiled into `:test` by `elixirc_paths/1` |
| `EbbServer.SSEHelpers`                  | test support                                             |
| `EbbServer.Integration.*`               | test support                                             |
| `EbbServer.Sync.Router.OperationSchema` | schema data; no test executes it yet — see below         |
| `EbbServer.Storage.PreparedAction`      | `defstruct` only                                         |
| `EbbServer.ActionExport.Supervisor`     | opt-in feature no test starts                            |

`lib/` alone is not the denominator: `test/support` is compiled into `:test`,
so an unfiltered run charges the tests for their own helpers. The ignore list
takes the number down, which is the point of an honest measurement.

`ignore_modules` accepts module atoms or `%Regex{}` — there are no globs, so
module families are matched by prefix regex.

`EbbServer.Sync.Router.OperationSchema` is ignored until a spec-generation test
executes the schemas; that test is slice 9 of
[#641](https://github.com/ebbjs/ebbjs/issues/641), and the ignore entry goes
away with it. It is 19 lines of pure data at 0%, and keeping it in would leave
the gate about one line of headroom.

## The total

With this filter the suite reports **90.0–90.1%** across runs (measured after
[#632](https://github.com/ebbjs/ebbjs/issues/632), which cleared the RocksDB
open/close failure paths, the storage tree's own restart path, and the
readiness probe's degraded-tree branch). Before that, the same suite reported
89.5–89.7%.
Unfiltered, the suite printed 76.89% (5660 lines, 1308 missed) before #632:
the difference is entirely bench, mix-task and test-support lines. To see that
view again, remove `test_coverage` from `mix.exs`; #640 quotes 77.0%/1302 from
a run whose ETS teardown happened to hit a few more lines.

The total moves by a few lines between runs: the ETS-lifecycle rescues across
the cache modules only execute when a table is already gone, so whether a
given run hits them depends on teardown ordering. Treat anything inside ~0.1pp
of the threshold as noise, not as a regression signal.

## The threshold

`summary: [threshold: 89]` in `ebb_server/mix.exs`. After #632 the suite sits
about a point above that, several times the run-to-run noise.

The threshold stays at 89 rather than moving to 90 with #632: the measured
total is close enough to 90 that a 90 gate would sit inside the noise band
above, and a gate that fails one run in five is worse than no gate.
[#641](https://github.com/ebbjs/ebbjs/issues/641) owns the bump, which lands
with its first slice — the readiness probe's degraded states — where the total
clears 90 with room to spare. Its slices are ranked by risk rather than by
distance to the number.

Raising the threshold without covering the lines behind it only turns a red
build into noise, so the number moves with the tests, not ahead of them.
