# Phase 1: Project Scaffold

> **Slice:** [01 — Single Action Write + Read-Back](../../slices/01-single-action-write-read.md)
> **Depends on:** Nothing
> **Produces:** A compiling Mix project with config, Application module, and test helpers

---

## Task 1. Scaffold the Mix project

**Files:** `ebb_server/mix.exs` (create), `ebb_server/.formatter.exs` (create), `ebb_server/.gitignore` (create)

Create the Mix project files manually (do not run `mix new` since `_build/` and `deps/` already exist from a previous attempt).

**`mix.exs`:**
- Module `EbbServer.MixProject`
- `app: :ebb_server`, `version: "0.1.0"`, `elixir: "~> 1.17"`
- `mod: {EbbServer.Application, []}` in `application/0`
- `extra_applications: [:logger, :runtime_tools]`
- Dependencies:
  - `{:rocksdb, "~> 2.5"}`
  - `{:exqlite, "~> 0.27"}`
  - `{:msgpax, "~> 2.4"}`
  - `{:plug_cowboy, "~> 2.7"}`
  - `{:jason, "~> 1.4"}`
  - `{:nanoid, "~> 2.1"}`

**`.formatter.exs`:**
- Standard Elixir formatter config: `[inputs: ["{mix,.formatter}.exs", "{config,lib,test}/**/*.{ex,exs}"]]`

**`.gitignore`:**
- Standard Elixir ignores: `/_build/`, `/deps/`, `/data/`, `*.ez`, `erl_crash.dump`, `.elixir_ls/`

---

## Task 2. Create config files

**Files:** `ebb_server/config/config.exs` (create), `ebb_server/config/test.exs` (create), `ebb_server/config/dev.exs` (create)

**`config/config.exs`:**
- `import Config`
- `config :ebb_server, port: 4000`
- `config :ebb_server, data_dir: "./data"`
- `import_config "#{config_env()}.exs"`

**`config/test.exs`:**
- `import Config`
- `config :ebb_server, port: 4001`
- `config :ebb_server, data_dir: "./data/test"`
- `config :logger, level: :warning`

**`config/dev.exs`:**
- `import Config`
- (empty for now, just `import Config`)

---

## Task 3. Create the Application module and top-level supervisor

**Files:** `ebb_server/lib/ebb_server.ex` (create), `ebb_server/lib/ebb_server/application.ex` (create)

**`lib/ebb_server.ex`:**
- Module `EbbServer` with a `@moduledoc` — just a namespace module for now.

**`lib/ebb_server/application.ex`:**
- Module `EbbServer.Application`, `use Application`
- `start/2` returns `Supervisor.start_link(children, opts)` with `strategy: :one_for_one`, `name: EbbServer.Supervisor`
- Children list initially empty — placeholder comments for `EbbServer.Storage.Supervisor` and HTTP server (Plug.Cowboy).

At this point the project should compile (`mix compile`) and `mix test` should pass with zero tests.

---

## Task 4. Create the test helper and test support utilities

**Files:** `ebb_server/test/test_helper.exs` (create), `ebb_server/test/support/test_helpers.ex` (create)

**`test/test_helper.exs`:**
- `ExUnit.start()`

**`test/support/test_helpers.ex`:**
- Module `EbbServer.TestHelpers`
- Function `tmp_dir(test_context)` — creates a unique temporary directory under `System.tmp_dir!()` using the test module + test name. Returns the path. Registers an `on_exit` callback that recursively deletes the directory.
- Function `generate_hlc()` — generates a 64-bit HLC from the current wall clock time with counter 0: `Bitwise.bsl(System.os_time(:millisecond), 16)`. This produces a proper HLC in the format documented in the [clock spec](/docs/clock): upper 48 bits = logical time (ms), lower 16 bits = counter.
- Function `hlc_from(logical_time_ms, counter \\ 0)` — builds a 64-bit HLC from explicit values: `Bitwise.bsl(logical_time_ms, 16) ||| counter`. Useful for tests that need deterministic HLC values or tiebreaker testing.
- Function `sample_action(overrides \\ %{})` — returns a valid action map with string keys:
  ```elixir
  %{
    "id" => "act_" <> Nanoid.generate(),
    "actor_id" => "a_test",
    "hlc" => generate_hlc(),
    "updates" => [sample_update()]
  }
  ```
  Merged with overrides.
- Function `sample_update(overrides \\ %{})` — returns a valid update map with string keys:
  ```elixir
  hlc = generate_hlc()
  %{
    "id" => "upd_" <> Nanoid.generate(),
    "subject_id" => "todo_" <> Nanoid.generate(),
    "subject_type" => "todo",
    "method" => "put",
    "data" => %{
      "fields" => %{
        "title" => %{"type" => "lww", "value" => "Buy milk", "hlc" => hlc},
        "completed" => %{"type" => "lww", "value" => false, "hlc" => hlc}
      }
    }
  }
  ```

Update `mix.exs` to add `elixirc_paths/1`: return `["lib", "test/support"]` for `:test` env, `["lib"]` otherwise.

---

## Verification

```bash
cd ebb_server && mix deps.get && mix compile && mix test
```

- Project compiles with zero warnings
- `mix test` passes with zero tests
- Config loads correctly in dev and test environments
