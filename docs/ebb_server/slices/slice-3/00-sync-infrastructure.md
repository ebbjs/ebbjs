# Sync Infrastructure Setup

## Build Order Position

**Step 0 of 5** -- Prerequisite infrastructure. Must be built before any sync components.

## Purpose

Set up the supervision tree and Registry infrastructure that all sync components depend on:

- `Registry` for group_id → pid lookups
- `EbbServer.Sync.Supervisor` as the container for all sync GenServers
- `GroupDynamicSupervisor` for transient per-Group GenServers
- `SSEConnectionSupervisor` for transient per-client SSE connections

## Responsibilities

- Provide a `GroupRegistry` via `Registry` with `keys: :unique`
- Provide a `Sync.Supervisor` that owns `FanOutRouter`, `GroupDynamicSupervisor`, and `SSEConnectionSupervisor`
- All sync children use `transient` restart strategy so they don't restart after normal shutdown

## Public Interface

### Registry

```elixir
# Module attribute for convenience
@registry EbbServer.Sync.GroupRegistry

# In application.ex or Sync.Supervisor:
Registry.start_link(keys: :unique)
```

### Supervisors

| Name                        | Type                                     | Children                                                            |
| --------------------------- | ---------------------------------------- | ------------------------------------------------------------------- |
| `EbbServer.Sync.Supervisor` | `Supervisor` (one_for_one)               | `FanOutRouter`, `GroupDynamicSupervisor`, `SSEConnectionSupervisor` |
| `GroupDynamicSupervisor`    | `DynamicSupervisor` (one_for_one)        | GroupServer processes (transient)                                   |
| `SSEConnectionSupervisor`   | `DynamicSupervisor` (simple_one_for_one) | SSEConnection processes (temporary)                                 |

## Supervision Tree

```
EbbServer.Supervisor
├── EbbServer.Storage.Supervisor
└── EbbServer.Sync.Supervisor  (one_for_one)
    ├── FanOutRouter
    ├── GroupDynamicSupervisor
    └── SSEConnectionSupervisor
```

## File Structure

```
lib/ebb_server/
├── sync/
│   ├── supervisor.ex          # EbbServer.Sync.Supervisor
│   └── sup/
│       ├── group_dynamic_supervisor.ex
│       └── sse_connection_supervisor.ex
└── application.ex            # Updated to start Sync.Supervisor
```

## Implementation

### Sync.Supervisor

```elixir
defmodule EbbServer.Sync.Supervisor do
  use Supervisor

  def start_link(opts) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    children = [
      EbbServer.Sync.FanOutRouter,
      {EbbServer.Sync.GroupDynamicSupervisor, strategy: :one_for_one},
      {EbbServer.Sync.SSEConnectionSupervisor, strategy: :simple_one_for_one}
    ]

    Supervisor.init(children, strategy: :one_for_one)
  end
end
```

### GroupDynamicSupervisor

```elixir
defmodule EbbServer.Sync.GroupDynamicSupervisor do
  use DynamicSupervisor

  def start_link(opts) do
    DynamicSupervisor.start_link(__MODULE__, strategy: :one_for_one, name: __MODULE__)
  end

  @impl true
  def init(opts) do
    DynamicSupervisor.init(strategy: :one_for_one, restarts: [100, 1])
  end
end
```

Note: `restarts: [100, 1]` means max 100 restarts in 1 second. This allows frequent group creation/destruction.

### SSEConnectionSupervisor

```elixir
defmodule EbbServer.Sync.SSEConnectionSupervisor do
  use DynamicSupervisor

  def start_link(opts) do
    DynamicSupervisor.start_link(__MODULE__, strategy: :simple_one_for_one, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    # simple_one_for_one: children are started on demand with start_child/2
    # restart: :temporary means SSEConnection never restarts (it handles its own cleanup)
    DynamicSupervisor.init(strategy: :simple_one_for_one)
  end
end
```

### Application Update

Add `Sync.Supervisor` and `Registry` to `EbbServer.Application`:

```elixir
def start(_type, _args) do
  port = Application.get_env(:ebb_server, :port, 4000)

  children = [
    EbbServer.Storage.Supervisor,
    # Step 0: Sync infrastructure
    {Registry, keys: :unique, name: EbbServer.Sync.GroupRegistry},
    EbbServer.Sync.Supervisor,
    {Bandit, plug: EbbServer.Sync.Router, port: port}
  ]

  opts = [strategy: :one_for_one, name: EbbServer.Supervisor]
  Supervisor.start_link(children, opts)
end
```

## Dependencies

| Dependency    | What it needs                                     | Reference                                 |
| ------------- | ------------------------------------------------- | ----------------------------------------- |
| GroupRegistry | `Registry.register/3`, `Registry.lookup/2`        | OTP built-in                              |
| FanOutRouter  | Started by Sync.Supervisor                        | [fan-out-router.md](03-fan-out-router.md) |
| GroupServer   | Started dynamically under GroupDynamicSupervisor  | [group-server.md](02-group-server.md)     |
| SSEConnection | Started dynamically under SSEConnectionSupervisor | [sse-connection.md](01-sse-connection.md) |

## Open Questions

- **Restart strategy**: `GroupDynamicSupervisor` uses `restarts: [100, 1]`. Is this appropriate for the expected churn rate?
- **Registry cleanup**: GroupServers are transient and self-terminate. When a GroupServer terminates normally, does Registry automatically unregister it? Need to verify `Registry.register/3` behavior on `terminate(:normal, ...)`.
