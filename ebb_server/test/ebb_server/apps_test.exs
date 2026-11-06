defmodule EbbServer.AppsTest do
  use ExUnit.Case, async: true

  import ExUnit.CaptureLog
  import EbbServer.TestHelpers

  alias EbbServer.Apps
  alias EbbServer.Apps.Store

  setup context do
    dir = tmp_dir(context)
    name = unique_name()
    key = unique_key()

    {:ok, pid} = Apps.start_link(data_dir: dir, name: name, key: key)

    on_exit(fn ->
      safe_stop(pid)
      :persistent_term.erase(key)
    end)

    {:ok,
     dir: dir, pid: pid, name: name, key: key, read_opts: [key: key], write_opts: [server: name]}
  end

  describe "add/3 and reads" do
    test "adds an app with a generated id and ISO8601 timestamp", ctx do
      app = add!(ctx, "notes", ["https://app.example.com"])

      assert "app_" <> suffix = app.id
      assert suffix != ""
      assert app.name == "notes"
      assert app.origins == ["https://app.example.com"]
      assert {:ok, _datetime, _offset} = DateTime.from_iso8601(app.created_at)

      assert Apps.get(app.id, ctx.read_opts) == {:ok, app}
      assert Apps.list(ctx.read_opts) == [app]
    end

    test "trims the name and canonicalizes origins", ctx do
      app = add!(ctx, "  Notes  ", ["HTTPS://App.Example.com:443/"])

      assert app.name == "Notes"
      assert app.origins == ["https://app.example.com"]
    end

    test "lists apps sorted by name", ctx do
      add!(ctx, "zeta", ["https://zeta.example.com"])
      add!(ctx, "alpha", ["https://alpha.example.com"])

      assert Enum.map(Apps.list(ctx.read_opts), & &1.name) == ["alpha", "zeta"]
    end

    test "get/2 returns :not_found for an unknown id", ctx do
      assert Apps.get("app_missing", ctx.read_opts) == {:error, :not_found}
    end

    test "rejects blank, oversized and non-binary names", ctx do
      assert Apps.add("", ["https://example.com"], ctx.write_opts) ==
               {:error, :invalid_name}

      assert Apps.add("   ", ["https://example.com"], ctx.write_opts) ==
               {:error, :invalid_name}

      assert Apps.add(String.duplicate("a", 101), ["https://example.com"], ctx.write_opts) ==
               {:error, :invalid_name}

      assert Apps.add(nil, ["https://example.com"], ctx.write_opts) ==
               {:error, :invalid_name}
    end

    test "accepts a name of exactly 100 characters", ctx do
      name = String.duplicate("a", 100)
      assert {:ok, %{name: ^name}} = Apps.add(name, ["https://example.com"], ctx.write_opts)
    end

    test "requires at least one valid origin", ctx do
      assert Apps.add("notes", [], ctx.write_opts) == {:error, :invalid_origin}
      assert Apps.add("notes", nil, ctx.write_opts) == {:error, :invalid_origin}

      assert Apps.add("notes", ["ftp://example.com"], ctx.write_opts) ==
               {:error, :invalid_origin}

      assert Apps.add("notes", ["https://example.com", "null"], ctx.write_opts) ==
               {:error, :invalid_origin}

      assert Apps.list(ctx.read_opts) == []
    end

    test "rejects a duplicate name case-insensitively after trimming", ctx do
      add!(ctx, "My App", ["https://a.example.com"])

      assert Apps.add("  my app  ", ["https://b.example.com"], ctx.write_opts) ==
               {:error, :duplicate_name}

      assert length(Apps.list(ctx.read_opts)) == 1
    end

    test "rejects an origin repeated within one request", ctx do
      assert Apps.add(
               "notes",
               ["https://a.example.com", "HTTPS://A.example.com:443"],
               ctx.write_opts
             ) ==
               {:error, :duplicate_origin}

      assert Apps.list(ctx.read_opts) == []
    end

    test "rejects an origin already registered to another app", ctx do
      add!(ctx, "first", ["https://a.example.com"])

      assert Apps.add("second", ["https://A.example.com/"], ctx.write_opts) ==
               {:error, :duplicate_origin}

      assert Enum.map(Apps.list(ctx.read_opts), & &1.name) == ["first"]
    end
  end

  describe "add_origin/3" do
    test "appends a canonical origin and returns the updated app", ctx do
      app = add!(ctx, "notes", ["https://a.example.com"])

      assert {:ok, updated} = Apps.add_origin(app.id, "HTTPS://B.example.com:443", ctx.write_opts)

      assert updated.id == app.id
      assert updated.origins == ["https://a.example.com", "https://b.example.com"]
      assert Apps.get(app.id, ctx.read_opts) == {:ok, updated}
    end

    test "returns :not_found for an unknown app", ctx do
      assert Apps.add_origin("app_missing", "https://b.example.com", ctx.write_opts) ==
               {:error, :not_found}
    end

    test "rejects an invalid origin", ctx do
      app = add!(ctx, "notes", ["https://a.example.com"])

      assert Apps.add_origin(app.id, "https://a.example.com/path", ctx.write_opts) ==
               {:error, :invalid_origin}
    end

    test "rejects an origin the app already has, under any spelling", ctx do
      app = add!(ctx, "notes", ["https://a.example.com"])

      assert Apps.add_origin(app.id, "HTTPS://A.example.com:443/", ctx.write_opts) ==
               {:error, :duplicate_origin}
    end

    test "rejects an origin registered to another app", ctx do
      app = add!(ctx, "notes", ["https://a.example.com"])
      add!(ctx, "docs", ["https://b.example.com"])

      assert Apps.add_origin(app.id, "https://b.example.com", ctx.write_opts) ==
               {:error, :duplicate_origin}
    end
  end

  describe "remove_origin/3" do
    test "removes an origin and returns the updated app", ctx do
      app = add!(ctx, "notes", ["https://a.example.com", "https://b.example.com"])

      assert {:ok, updated} =
               Apps.remove_origin(app.id, "HTTPS://A.example.com:443", ctx.write_opts)

      assert updated.origins == ["https://b.example.com"]
      assert Apps.get(app.id, ctx.read_opts) == {:ok, updated}
    end

    test "returns :not_found for an unknown app", ctx do
      assert Apps.remove_origin("app_missing", "https://a.example.com", ctx.write_opts) ==
               {:error, :not_found}
    end

    test "returns :origin_not_found when the app does not have the origin", ctx do
      app = add!(ctx, "notes", ["https://a.example.com"])

      assert Apps.remove_origin(app.id, "https://b.example.com", ctx.write_opts) ==
               {:error, :origin_not_found}
    end

    test "rejects an invalid origin", ctx do
      app = add!(ctx, "notes", ["https://a.example.com"])

      assert Apps.remove_origin(app.id, "null", ctx.write_opts) == {:error, :invalid_origin}
    end
  end

  describe "remove/2" do
    test "removes the app and persists the change", ctx do
      app = add!(ctx, "notes", ["https://a.example.com"])

      assert Apps.remove(app.id, ctx.write_opts) == :ok
      assert Apps.get(app.id, ctx.read_opts) == {:error, :not_found}
      assert Apps.list(ctx.read_opts) == []

      assert %{"apps" => []} = read_document(ctx.dir)
    end

    test "returns :not_found for an unknown app", ctx do
      assert Apps.remove("app_missing", ctx.write_opts) == {:error, :not_found}
    end
  end

  describe "match_origin/2" do
    test "matches an exact registered origin", ctx do
      app = add!(ctx, "notes", ["https://a.example.com"])

      assert Apps.match_origin("https://a.example.com", ctx.read_opts) == {:ok, app.id}
      assert Apps.match_origin("HTTPS://A.example.com:443/", ctx.read_opts) == {:ok, app.id}
    end

    test "matches through a registered wildcard origin", ctx do
      app = add!(ctx, "previews", ["https://*.preview.example.com"])

      assert Apps.match_origin("https://pr-1.preview.example.com", ctx.read_opts) == {:ok, app.id}

      assert Apps.match_origin("https://a.b.preview.example.com", ctx.read_opts) ==
               {:ok, app.id}
    end

    test "returns :error when nothing matches", ctx do
      add!(ctx, "notes", ["https://a.example.com"])

      assert Apps.match_origin("https://b.example.com", ctx.read_opts) == :error
      assert Apps.match_origin("null", ctx.read_opts) == :error
    end

    test "stops matching after the origin is removed", ctx do
      app = add!(ctx, "notes", ["https://a.example.com"])

      assert {:ok, _app} = Apps.remove_origin(app.id, "https://a.example.com", ctx.write_opts)
      assert Apps.match_origin("https://a.example.com", ctx.read_opts) == :error
    end
  end

  describe "reads" do
    test "are served from persistent_term and survive the owning process", ctx do
      app = add!(ctx, "notes", ["https://a.example.com"])

      safe_stop(ctx.pid)

      assert Apps.list(ctx.read_opts) == [app]
      assert Apps.match_origin("https://a.example.com", ctx.read_opts) == {:ok, app.id}
    end
  end

  describe "persistence" do
    test "writes a versioned document atomically with no temp file left behind", ctx do
      app = add!(ctx, "notes", ["https://a.example.com"])

      assert %{
               "version" => 1,
               "apps" => [
                 %{
                   "id" => id,
                   "name" => "notes",
                   "origins" => ["https://a.example.com"],
                   "created_at" => created_at
                 }
               ]
             } = read_document(ctx.dir)

      assert id == app.id
      assert created_at == app.created_at
      assert Path.wildcard(Path.join(ctx.dir, "*.tmp")) == []
    end

    test "loads the registry a previous process wrote", ctx do
      app = add!(ctx, "notes", ["https://*.example.com", "http://localhost:4000"])
      safe_stop(ctx.pid)

      fresh = start_registry(ctx.dir)

      assert Apps.list(fresh.read_opts) == [app]
      assert Apps.get(app.id, fresh.read_opts) == {:ok, app}
    end

    test "starts empty when no file exists and logs nothing", ctx do
      logs = capture_log(fn -> Apps.list(ctx.read_opts) end)

      assert Apps.list(ctx.read_opts) == []
      assert logs == ""
    end

    test "fails closed on invalid JSON, names the file, and leaves it untouched", ctx do
      write_document(ctx.dir, "{not json")

      logs = start_and_capture_log(ctx.dir)

      assert logs =~ Store.path(ctx.dir)
    end

    test "fails closed on an unknown version", ctx do
      write_document(ctx.dir, Jason.encode!(%{"version" => 2, "apps" => []}))

      logs = start_and_capture_log(ctx.dir)

      assert logs =~ Store.path(ctx.dir)
    end

    test "fails closed on a bad shape", ctx do
      write_document(ctx.dir, Jason.encode!(%{"version" => 1, "apps" => [%{"id" => "app_1"}]}))

      logs = start_and_capture_log(ctx.dir)

      assert logs =~ Store.path(ctx.dir)
    end

    test "fails closed on duplicate names", ctx do
      document = %{
        "version" => 1,
        "apps" => [stored_app("app_1", "Notes"), stored_app("app_2", "  notes  ")]
      }

      write_document(ctx.dir, Jason.encode!(document))
      logs = start_and_capture_log(ctx.dir)

      assert logs =~ Store.path(ctx.dir)
    end

    test "fails closed on duplicate origins", ctx do
      document = %{
        "version" => 1,
        "apps" => [
          stored_app("app_1", "first", ["https://a.example.com"]),
          stored_app("app_2", "second", ["HTTPS://A.example.com:443"])
        ]
      }

      write_document(ctx.dir, Jason.encode!(document))
      logs = start_and_capture_log(ctx.dir)

      assert logs =~ Store.path(ctx.dir)
    end

    test "fails closed on an invalid origin", ctx do
      document = %{"version" => 1, "apps" => [stored_app("app_1", "notes", ["null"])]}

      write_document(ctx.dir, Jason.encode!(document))
      logs = start_and_capture_log(ctx.dir)

      assert logs =~ Store.path(ctx.dir)
    end

    test "reports :storage_error and keeps memory unchanged when a write fails", ctx do
      File.mkdir_p!(Store.path(ctx.dir))

      assert Apps.add("notes", ["https://a.example.com"], ctx.write_opts) ==
               {:error, :storage_error}

      assert Apps.list(ctx.read_opts) == []
      assert Path.wildcard(Path.join(ctx.dir, "*.tmp")) == []
    end
  end

  describe "reset/1" do
    test "clears the registry in memory and on disk", ctx do
      add!(ctx, "notes", ["https://a.example.com"])

      assert Apps.reset(ctx.write_opts) == :ok
      assert Apps.list(ctx.read_opts) == []
      assert %{"version" => 1, "apps" => []} = read_document(ctx.dir)

      assert {:ok, app} = Apps.add("docs", ["https://docs.example.com"], ctx.write_opts)
      assert Apps.list(ctx.read_opts) == [app]
    end

    test "is idempotent on an empty registry", ctx do
      assert Apps.reset(ctx.write_opts) == :ok
      assert Apps.reset(ctx.write_opts) == :ok
      assert Apps.list(ctx.read_opts) == []
    end
  end

  defp add!(ctx, name, origins) do
    assert {:ok, app} = Apps.add(name, origins, ctx.write_opts)
    app
  end

  defp read_document(dir) do
    dir |> Store.path() |> File.read!() |> Jason.decode!()
  end

  defp write_document(dir, content) do
    File.mkdir_p!(dir)
    File.write!(Store.path(dir), content)
  end

  defp stored_app(id, name, origins \\ ["https://example.com"]) do
    %{
      "id" => id,
      "name" => name,
      "origins" => origins,
      "created_at" => "2026-01-01T00:00:00Z"
    }
  end

  # Starts a registry on `dir` inside `capture_log/1` so a boot-time load
  # failure is visible even though the process outlives the capture.
  defp start_and_capture_log(dir) do
    parent = self()
    ctx = start_registry(dir, report: parent)
    logs = ctx.log
    assert Apps.list(ctx.read_opts) == []
    logs
  end

  defp start_registry(dir, opts \\ []) do
    name = unique_name()
    key = unique_key()
    parent = Keyword.get(opts, :report)

    log =
      capture_log(fn ->
        {:ok, pid} = Apps.start_link(data_dir: dir, name: name, key: key)

        if parent, do: send(parent, {:apps_pid, pid})

        on_exit(fn ->
          safe_stop(pid)
          :persistent_term.erase(key)
        end)
      end)

    %{pid: nil, name: name, key: key, read_opts: [key: key], write_opts: [server: name], log: log}
  end

  defp unique_name, do: :"ebb_apps_#{System.unique_integer([:positive])}"
  defp unique_key, do: {Apps, make_ref()}
end
