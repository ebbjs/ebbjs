defmodule EbbServer.Functions.StoreTest do
  use ExUnit.Case, async: false

  alias EbbServer.Functions.Bundle
  alias EbbServer.Functions.Store
  alias EbbServer.TestHelpers
  alias Exqlite.Sqlite3

  @name "addNumbers"
  @code "export const add = (params) => params.a + params.b;\n"

  setup context do
    %{data_dir: TestHelpers.tmp_dir(context)}
  end

  defp start_store(%{data_dir: data_dir}, opts \\ []) do
    start_supervised!(
      Supervisor.child_spec({Store, [name: nil, data_dir: data_dir] ++ opts}, id: make_ref())
    )
  end

  defp attrs(overrides \\ %{}) do
    Map.merge(
      %{
        name: @name,
        version: "1.0.0",
        code: @code,
        digest: Bundle.digest_for(@code),
        runtime: "bun",
        entry: "add",
        access: "granted",
        contract: 1,
        timeout_ms: 5_000,
        memory_bytes: 64 * 1024 * 1024,
        params_schema: %{
          "type" => "object",
          "properties" => %{"a" => %{"type" => "number"}, "b" => %{"type" => "number"}}
        },
        output_schema: %{"type" => "number"}
      },
      overrides
    )
  end

  defp put!(store, overrides \\ %{}) do
    assert {:ok, version} = Store.put_version(attrs(overrides), store)
    version
  end

  defp versions(name, store) do
    assert {:ok, versions} = Store.versions(name, store)
    versions
  end

  describe "put_version/2" do
    test "stores a retired row with decoded schemas", %{data_dir: _} = context do
      store = start_store(context)

      assert {:ok, version} = Store.put_version(attrs(), store)

      assert version.status == "retired"
      assert version.activated_at == nil
      assert version.name == @name
      assert version.version == "1.0.0"
      assert version.code == @code
      assert version.digest == Bundle.digest_for(@code)
      assert version.runtime == "bun"
      assert version.entry == "add"
      assert version.access == "granted"
      assert version.contract == 1
      assert version.timeout_ms == 5_000
      assert version.memory_bytes == 64 * 1024 * 1024
      assert version.pinned == false
      assert String.starts_with?(version.id, "fv_")
      assert version.params_schema["type"] == "object"
      assert version.output_schema == %{"type" => "number"}
      assert is_integer(version.created_at)

      assert [stored] = versions(@name, store)
      assert stored.id == version.id
      assert Store.active(@name, store) == :not_found
    end

    test "accepts a version with no schemas", %{data_dir: _} = context do
      store = start_store(context)

      assert {:ok, version} =
               Store.put_version(attrs(%{params_schema: nil, output_schema: nil}), store)

      assert version.params_schema == nil
      assert version.output_schema == nil
    end

    test "a duplicate name and version is refused and the code is unchanged", context do
      store = start_store(context)
      put!(store)

      assert {:error, :already_exists} =
               Store.put_version(attrs(%{code: "export const add = () => 0;\n"}), store)

      assert {:ok, stored} = Store.get(@name, "1.0.0", store)
      assert stored.code == @code
      assert length(versions(@name, store)) == 1
    end

    test "an unresolvable params schema is refused before the row exists", context do
      store = start_store(context)

      assert {:error, {:invalid_schema, "params_schema", reason}} =
               Store.put_version(attrs(%{params_schema: %{"type" => "nonsense"}}), store)

      assert is_binary(reason)
      assert versions(@name, store) == []
    end

    test "an unresolvable output schema is refused", context do
      store = start_store(context)

      assert {:error, {:invalid_schema, "output_schema", _reason}} =
               Store.put_version(attrs(%{output_schema: %{"properties" => "nope"}}), store)

      assert versions(@name, store) == []
    end

    test "accepts a boolean draft-7 schema, which accepts everything or nothing", context do
      store = start_store(context)

      assert {:ok, version} =
               Store.put_version(attrs(%{params_schema: true, output_schema: false}), store)

      assert version.params_schema == true
      assert version.output_schema == false
    end

    test "a missing required attribute is a reply, not a crash", context do
      store = start_store(context)

      assert {:error, {:missing_field, :code}} =
               Store.put_version(Map.delete(attrs(), :code), store)

      assert versions(@name, store) == []
    end

    test "created_by and pinned round-trip", context do
      store = start_store(context)

      assert {:ok, version} =
               Store.put_version(attrs(%{created_by: "actor_1", pinned: true}), store)

      assert version.created_by == "actor_1"
      assert version.pinned == true

      assert {:ok, stored} = Store.get(@name, "1.0.0", store)
      assert stored.created_by == "actor_1"
      assert stored.pinned == true
    end
  end

  describe "activate/3" do
    test "makes exactly one active row for the name", context do
      store = start_store(context)
      put!(store)

      assert {:ok, active} = Store.activate(@name, "1.0.0", store)
      assert active.status == "active"
      assert is_integer(active.activated_at)

      assert {:ok, %{status: "active"}} = Store.active(@name, store)
      assert {:ok, [%{version: "1.0.0"}]} = Store.list(store)
    end

    test "activating a second version retires the first, and list shows only the active one",
         context do
      store = start_store(context)
      put!(store)
      put!(store, %{version: "2.0.0"})

      assert {:ok, _} = Store.activate(@name, "1.0.0", store)
      assert {:ok, _} = Store.activate(@name, "2.0.0", store)

      assert {:ok, %{version: "2.0.0"}} = Store.active(@name, store)
      assert {:ok, %{status: "retired"}} = Store.get(@name, "1.0.0", store)
      assert {:ok, [%{version: "2.0.0"}]} = Store.list(store)
    end

    test "list orders active names and answers :not_found for unknown ones", context do
      store = start_store(context)
      put!(store, %{name: "betaFunction"})
      put!(store, %{name: "alphaFunction"})

      assert {:ok, _} = Store.activate("betaFunction", "1.0.0", store)
      assert {:ok, _} = Store.activate("alphaFunction", "1.0.0", store)

      assert {:ok, versions} = Store.list(store)
      assert ["alphaFunction", "betaFunction"] = Enum.map(versions, & &1.name)
      assert Store.active("gammaFunction", store) == :not_found
      assert Store.get("alphaFunction", "9.9.9", store) == :not_found
    end

    test "activating the active version is an idempotent success that refreshes activated_at",
         context do
      store = start_store(context)
      put!(store)

      assert {:ok, first} = Store.activate(@name, "1.0.0", store)
      assert {:ok, second} = Store.activate(@name, "1.0.0", store)

      assert second.status == "active"
      assert second.activated_at >= first.activated_at
      assert {:ok, [%{version: "1.0.0"}]} = Store.list(store)
    end

    test "an unknown version changes nothing", context do
      store = start_store(context)
      put!(store)
      put!(store, %{version: "2.0.0"})
      assert {:ok, _} = Store.activate(@name, "1.0.0", store)
      before = versions(@name, store)

      assert {:error, :not_found} = Store.activate(@name, "9.9.9", store)

      assert {:ok, %{version: "1.0.0"}} = Store.active(@name, store)
      assert versions(@name, store) == before
    end

    test "a row whose stored schema was corrupted cannot be activated", context do
      store = start_store(context)
      put!(store)

      corrupt_schema(context, "1.0.0", ~s({"type":"nonsense"}))

      assert {:error, {:invalid_schema, "params_schema", _reason}} =
               Store.activate(@name, "1.0.0", store)

      assert Store.active(@name, store) == :not_found
    end
  end

  describe "rollback/2" do
    test "walks back through activations rather than toggling", context do
      store = start_store(context)
      put!(store)
      put!(store, %{version: "2.0.0"})
      put!(store, %{version: "3.0.0"})

      assert {:ok, _} = Store.activate(@name, "1.0.0", store)
      assert {:ok, _} = Store.activate(@name, "2.0.0", store)
      assert {:ok, _} = Store.activate(@name, "3.0.0", store)

      assert {:ok, %{version: "2.0.0", status: "active"}} = Store.rollback(@name, store)
      assert {:ok, %{version: "2.0.0"}} = Store.active(@name, store)

      assert {:ok, %{version: "1.0.0", status: "active"}} = Store.rollback(@name, store)
      assert {:ok, %{version: "1.0.0"}} = Store.active(@name, store)

      assert {:error, :no_previous_version} = Store.rollback(@name, store)
    end

    test "activation records the row that was active before it", context do
      store = start_store(context)
      v1 = put!(store)
      v2 = put!(store, %{version: "2.0.0"})

      assert {:ok, _} = Store.activate(@name, "1.0.0", store)
      assert {:ok, active} = Store.activate(@name, "2.0.0", store)

      assert active.previous_version_id == v1.id
      assert {:ok, %{previous_version_id: nil}} = Store.get(@name, "1.0.0", store)
      assert v2.previous_version_id == nil
    end

    test "re-enabling a disabled version keeps its rollback chain", context do
      store = start_store(context)
      put!(store)
      put!(store, %{version: "2.0.0"})

      assert {:ok, _} = Store.activate(@name, "1.0.0", store)
      assert {:ok, _} = Store.activate(@name, "2.0.0", store)
      assert {:ok, %{status: "disabled"}} = Store.disable(@name, store)

      assert {:ok, active} = Store.activate(@name, "2.0.0", store)
      assert active.previous_version_id != nil

      assert {:ok, %{version: "1.0.0"}} = Store.rollback(@name, store)
    end

    test "a disabled version is not a rollback candidate", context do
      store = start_store(context)
      put!(store)
      put!(store, %{version: "2.0.0"})
      put!(store, %{version: "3.0.0"})

      assert {:ok, _} = Store.activate(@name, "1.0.0", store)
      assert {:ok, _} = Store.activate(@name, "2.0.0", store)
      assert {:ok, _} = Store.activate(@name, "3.0.0", store)

      # v3 points at v2; rolling back makes v2 active, then disabling it leaves
      # v3's pointer aimed at a row that is no longer a rollback candidate.
      assert {:ok, %{version: "2.0.0"}} = Store.rollback(@name, store)
      assert {:ok, %{status: "disabled"}} = Store.disable(@name, store)
      assert {:ok, %{version: "3.0.0"}} = Store.activate(@name, "3.0.0", store)

      assert {:error, :no_previous_version} = Store.rollback(@name, store)
      assert {:ok, %{version: "3.0.0"}} = Store.active(@name, store)
    end

    test "a name with no active version has nothing to roll back from", context do
      store = start_store(context)
      put!(store)

      assert {:error, :not_found} = Store.rollback(@name, store)
    end

    test "an active version with no earlier activation answers :no_previous_version", context do
      store = start_store(context)
      put!(store)
      assert {:ok, _} = Store.activate(@name, "1.0.0", store)

      assert {:error, :no_previous_version} = Store.rollback(@name, store)
      assert {:ok, %{version: "1.0.0"}} = Store.active(@name, store)
    end
  end

  describe "disable/2" do
    test "removes the name from the active set and re-activation restores it", context do
      store = start_store(context)
      put!(store)
      assert {:ok, _} = Store.activate(@name, "1.0.0", store)

      assert {:ok, disabled} = Store.disable(@name, store)
      assert disabled.status == "disabled"

      assert Store.active(@name, store) == :not_found
      assert Store.list(store) == {:ok, []}
      assert {:ok, %{status: "disabled"}} = Store.get(@name, "1.0.0", store)

      assert {:ok, %{status: "active"}} = Store.activate(@name, "1.0.0", store)
      assert {:ok, %{version: "1.0.0"}} = Store.active(@name, store)
      assert {:ok, [%{version: "1.0.0"}]} = Store.list(store)
    end

    test "a name with no active version answers :not_found", context do
      store = start_store(context)
      put!(store)

      assert {:error, :not_found} = Store.disable(@name, store)
    end
  end

  describe "the schema constraints" do
    test "the partial unique index refuses a second active row for the same name", context do
      store = start_store(context)
      put!(store)
      assert {:ok, _} = Store.activate(@name, "1.0.0", store)

      db = open_direct(context)
      insert_direct!(db, "fv_other", @name, "2.0.0", "active") |> assert_checked()
      Sqlite3.close(db)
    end

    test "the CHECK constraint refuses a status outside the vocabulary", context do
      store = start_store(context)
      put!(store)

      db = open_direct(context)
      insert_direct!(db, "fv_other", @name, "2.0.0", "garbage") |> assert_checked()
      Sqlite3.close(db)
    end

    test "the CHECK constraint accepts disabled, so a disabled version holds no active slot",
         context do
      store = start_store(context)
      put!(store)

      db = open_direct(context)
      assert :done == insert_direct!(db, "fv_other", @name, "2.0.0", "disabled")
      Sqlite3.close(db)

      assert {:ok, %{status: "disabled"}} = Store.get(@name, "2.0.0", store)
    end
  end

  describe "retention" do
    test "keeps the newest N versions of a name", context do
      store = start_store(context, retention: 3)

      for version <- ~w(1.0.0 2.0.0 3.0.0 4.0.0 5.0.0), do: put!(store, %{version: version})

      assert ~w(5.0.0 4.0.0 3.0.0) = Enum.map(versions(@name, store), & &1.version)
    end

    test "a pinned version survives past N", context do
      store = start_store(context, retention: 3)
      put!(store, %{version: "1.0.0", pinned: true})

      for version <- ~w(2.0.0 3.0.0 4.0.0 5.0.0), do: put!(store, %{version: version})

      assert ~w(5.0.0 4.0.0 3.0.0 1.0.0) = Enum.map(versions(@name, store), & &1.version)
    end

    test "a pinned version does not consume a retention slot", context do
      store = start_store(context, retention: 3)

      put!(store, %{version: "2.0.0", pinned: true})
      for version <- ~w(1.0.0 3.0.0 4.0.0), do: put!(store, %{version: version})

      assert ~w(1.0.0 2.0.0 3.0.0 4.0.0) =
               @name |> versions(store) |> Enum.map(& &1.version) |> Enum.sort()
    end

    test "the active version is never pruned", context do
      store = start_store(context, retention: 3)
      put!(store)
      assert {:ok, _} = Store.activate(@name, "1.0.0", store)

      for version <- ~w(2.0.0 3.0.0 4.0.0 5.0.0), do: put!(store, %{version: version})

      assert {:ok, %{version: "1.0.0"}} = Store.active(@name, store)
      assert ~w(5.0.0 4.0.0 3.0.0 1.0.0) = Enum.map(versions(@name, store), & &1.version)
    end

    test "retention is per name", context do
      store = start_store(context, retention: 2)

      for version <- ~w(1.0.0 2.0.0 3.0.0), do: put!(store, %{version: version})
      put!(store, %{name: "otherFunction", version: "1.0.0"})

      assert ~w(3.0.0 2.0.0) = Enum.map(versions(@name, store), & &1.version)
      assert [%{version: "1.0.0"}] = versions("otherFunction", store)
    end
  end

  describe "restart" do
    test "preserves versions and the active pointer", context do
      store = start_store(context)
      put!(store)
      put!(store, %{version: "2.0.0"})
      assert {:ok, activated} = Store.activate(@name, "2.0.0", store)

      :ok = GenServer.stop(store)

      restarted = start_store(context)

      assert {:ok, active} = Store.active(@name, restarted)
      assert active.id == activated.id
      assert active.version == "2.0.0"
      assert active.code == @code
      assert active.params_schema == activated.params_schema
      assert active.output_schema == activated.output_schema

      assert length(versions(@name, restarted)) == 2
    end
  end

  describe "migrations" do
    test "a v1 database gains previous_version_id without losing rows", context do
      {:ok, db} = Sqlite3.open(db_path(context))
      :ok = Sqlite3.execute(db, v1_ddl())
      :ok = Sqlite3.execute(db, "PRAGMA user_version = 1")
      assert :done == insert_direct!(db, "fv_v1", @name, "1.0.0", "active")
      :ok = Sqlite3.close(db)

      store = start_store(context)

      assert {:ok, active} = Store.active(@name, store)
      assert active.id == "fv_v1"
      assert active.previous_version_id == nil
      assert {:ok, [%{version: "1.0.0"}]} = Store.versions(@name, store)
    end
  end

  # ---------------------------------------------------------------------------
  # Direct database access, for the constraints the application must not be the
  # thing enforcing
  # ---------------------------------------------------------------------------

  defp db_path(%{data_dir: data_dir}), do: Path.join(data_dir, "functions.db")

  defp open_direct(context) do
    {:ok, db} = Sqlite3.open(db_path(context))
    db
  end

  # The exact schema `functions.db` had before migration v2. A database created
  # by #595 must upgrade in place.
  defp v1_ddl do
    """
    CREATE TABLE function_versions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      code TEXT NOT NULL,
      digest TEXT NOT NULL,
      signature TEXT,
      signer_key_id TEXT,
      runtime TEXT NOT NULL,
      entry TEXT NOT NULL,
      access TEXT NOT NULL,
      params_schema TEXT,
      output_schema TEXT,
      contract TEXT NOT NULL,
      timeout_ms INTEGER NOT NULL,
      memory_bytes INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active','retired','disabled')),
      created_at INTEGER NOT NULL,
      activated_at INTEGER,
      created_by TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      UNIQUE (name, version)
    );
    CREATE UNIQUE INDEX idx_function_active ON function_versions(name) WHERE status = 'active';
    CREATE INDEX idx_function_versions_name ON function_versions(name, created_at DESC);
    """
  end

  defp insert_direct!(db, id, name, version, status) do
    {:ok, stmt} =
      Sqlite3.prepare(db, """
      INSERT INTO function_versions (
        id, name, version, code, digest, runtime, entry, access, contract,
        timeout_ms, memory_bytes, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      """)

    :ok =
      Sqlite3.bind(stmt, [
        id,
        name,
        version,
        @code,
        Bundle.digest_for(@code),
        "bun",
        "add",
        "granted",
        "1",
        5_000,
        1_048_576,
        status,
        System.system_time(:millisecond)
      ])

    result = Sqlite3.step(db, stmt)
    Sqlite3.release(db, stmt)
    result
  end

  defp assert_checked({:error, reason}) when is_binary(reason), do: :ok

  defp assert_checked(other), do: flunk("expected a constraint error, got: #{inspect(other)}")

  defp corrupt_schema(%{data_dir: data_dir}, version, json) do
    {:ok, db} = Sqlite3.open(Path.join(data_dir, "functions.db"))

    {:ok, stmt} =
      Sqlite3.prepare(
        db,
        "UPDATE function_versions SET params_schema = ? WHERE name = ? AND version = ?"
      )

    :ok = Sqlite3.bind(stmt, [json, @name, version])
    :done = Sqlite3.step(db, stmt)
    :ok = Sqlite3.release(db, stmt)
    :ok = Sqlite3.close(db)
  end
end
