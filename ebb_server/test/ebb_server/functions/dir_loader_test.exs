defmodule EbbServer.Functions.Bundle.DirLoaderTest do
  use ExUnit.Case, async: true

  alias EbbServer.Functions.Bundle
  alias EbbServer.Functions.Bundle.DirLoader
  alias EbbServer.TestFunctions.Bundles

  setup do
    %{dir: Bundles.tmp_bundle_dir()}
  end

  defp load(dir, name \\ "proofreadDocument") do
    DirLoader.load(name, dir: dir)
  end

  describe "the active bundle" do
    test "is the envelope and code pair for the name", %{dir: dir} do
      Bundles.write_bundle!(dir, Bundles.envelope("proofreadDocument"))

      assert {:ok, envelope, code} = load(dir)
      assert envelope["name"] == "proofreadDocument"
      assert envelope["version"] == "1.0.0"
      assert code == Bundles.code()
    end

    test "is the newest envelope mtime, not the last file written", %{dir: dir} do
      new = Bundles.envelope("proofreadDocument", %{"version" => "2.0.0"})
      old = Bundles.envelope("proofreadDocument", %{"version" => "1.0.0"})

      new_path = Bundles.write_envelope!(dir, new)
      Bundles.write_code!(dir, "proofreadDocument", "2.0.0")
      Bundles.set_mtime!(new_path, 1_600_000_100)

      old_path = Bundles.write_envelope!(dir, old)
      Bundles.write_code!(dir, "proofreadDocument", "1.0.0")
      Bundles.set_mtime!(old_path, 1_600_000_000)

      assert {:ok, %{"version" => "2.0.0"}, _code} = load(dir)

      # Making the older version the most recently touched one flips the
      # answer without dropping a single file.
      Bundles.set_mtime!(old_path, 1_600_000_200)

      assert {:ok, %{"version" => "1.0.0"}, _code} = load(dir)
    end

    test "breaks an mtime tie by version, so the answer never depends on fs order", %{dir: dir} do
      for version <- ["1.0.0", "2.0.0"] do
        path =
          Bundles.write_envelope!(
            dir,
            Bundles.envelope("proofreadDocument", %{"version" => version})
          )

        Bundles.write_code!(dir, "proofreadDocument", version)
        Bundles.set_mtime!(path, 1_600_000_000)
      end

      assert {:ok, %{"version" => "2.0.0"}, _code} = load(dir)
    end
  end

  describe "reading the directory again" do
    test "picks up a bundle replaced on disk without a restart", %{dir: dir} do
      Bundles.write_bundle!(dir, Bundles.envelope("proofreadDocument"))

      assert {:ok, _envelope, first} = load(dir)
      assert first == Bundles.code()

      replacement = "export const proofreadDocument = () => ({ ok: false });"

      Bundles.write_bundle!(
        dir,
        Bundles.envelope("proofreadDocument", %{"digest" => Bundle.digest_for(replacement)}),
        replacement
      )

      assert {:ok, _envelope, ^replacement} = load(dir)
    end

    test "reports a bundle that disappeared on the next call", %{dir: dir} do
      Bundles.write_bundle!(dir, Bundles.envelope("proofreadDocument"))
      assert {:ok, _envelope, _code} = load(dir)

      File.rm!(Path.join(dir, "proofreadDocument@1.0.0.envelope.json"))

      assert {:error, {:missing_envelope, "proofreadDocument"}} = load(dir)
    end
  end

  describe "a name with no bundle" do
    test "is not found when the directory holds nothing for it", %{dir: dir} do
      Bundles.write_bundle!(dir, Bundles.envelope("otherFunction"))

      assert :not_found = load(dir)
      assert :not_found = load(dir, "neverDeployed")
    end

    test "is not found when the directory does not exist" do
      missing =
        Path.join(
          System.tmp_dir!(),
          "ebb_server_no_such_dir_#{System.unique_integer([:positive])}"
        )

      assert {:error, {:unreadable_dir, ^missing, :enoent}} =
               DirLoader.load("proofreadDocument", dir: missing)
    end
  end

  describe "a broken deployment" do
    test "an envelope that is not JSON is an error, not a miss", %{dir: dir} do
      basename = "proofreadDocument@1.0.0.envelope.json"
      Bundles.write_raw!(dir, basename, "{not json")

      assert {:error, {:malformed_envelope, ^basename, _reason}} = load(dir)
    end

    test "an envelope that is not a JSON object is an error", %{dir: dir} do
      basename = "proofreadDocument@1.0.0.envelope.json"
      Bundles.write_raw!(dir, basename, "[]")

      assert {:error, {:malformed_envelope, ^basename, :not_an_object}} = load(dir)
    end

    test "an unreadable envelope is an error", %{dir: dir} do
      basename = "proofreadDocument@1.0.0.envelope.json"
      File.mkdir_p!(Path.join(dir, basename))

      assert {:error, {:unreadable, ^basename, :eisdir}} = load(dir)
    end

    test "an unreadable code file is an error", %{dir: dir} do
      Bundles.write_envelope!(dir, Bundles.envelope("proofreadDocument"))
      File.mkdir_p!(Path.join(dir, "proofreadDocument@1.0.0.js"))

      assert {:error, {:unreadable, "proofreadDocument@1.0.0.js", :eisdir}} = load(dir)
    end

    test "an envelope whose version disagrees with its filename is refused", %{dir: dir} do
      basename = "proofreadDocument@2.0.0.envelope.json"

      Bundles.write_envelope!(dir, Bundles.envelope("proofreadDocument"), "2.0.0")
      Bundles.write_code!(dir, "proofreadDocument", "2.0.0")

      assert {:error, {:version_mismatch, ^basename, "1.0.0"}} = load(dir)
    end

    test "an envelope whose name disagrees with the requested name is refused", %{dir: dir} do
      basename = "proofreadDocument@1.0.0.envelope.json"

      Bundles.write_raw!(dir, basename, Jason.encode!(Bundles.envelope("otherFunction")))
      Bundles.write_code!(dir, "proofreadDocument", "1.0.0")

      assert {:error, {:name_mismatch, ^basename, "otherFunction"}} = load(dir)
    end

    test "two envelopes carrying the same version are a duplicate active version", %{dir: dir} do
      envelope = Bundles.envelope("proofreadDocument")

      Bundles.write_envelope!(dir, envelope, "1.0.0")
      Bundles.write_envelope!(dir, envelope, "1.0.0-copy")
      Bundles.write_code!(dir, "proofreadDocument", "1.0.0")

      assert {:error, {:duplicate_active_version, "1.0.0"}} = load(dir)
    end

    test "an envelope with no version in its filename is malformed", %{dir: dir} do
      basename = "proofreadDocument@.envelope.json"
      Bundles.write_raw!(dir, basename, Jason.encode!(Bundles.envelope("proofreadDocument")))

      assert {:error, {:malformed_filename, ^basename}} = load(dir)
    end

    test "a code file without an envelope is an error", %{dir: dir} do
      Bundles.write_code!(dir, "proofreadDocument", "1.0.0")

      assert {:error, {:missing_envelope, "proofreadDocument"}} = load(dir)
    end

    test "an envelope without its code file is an error", %{dir: dir} do
      Bundles.write_envelope!(dir, Bundles.envelope("proofreadDocument"))

      assert {:error, {:missing_code, "proofreadDocument", "1.0.0"}} = load(dir)
    end
  end

  describe "files the loader does not own" do
    test "are ignored, so a source map cannot disable a function", %{dir: dir} do
      Bundles.write_bundle!(dir, Bundles.envelope("proofreadDocument"))
      Bundles.write_raw!(dir, "proofreadDocument@1.0.0.js.map", "{}")
      Bundles.write_raw!(dir, "README.md", "deploy notes")

      assert {:ok, _envelope, _code} = load(dir)
    end

    test "do not make a name with no bundle found", %{dir: dir} do
      Bundles.write_raw!(dir, "proofreadDocument@1.0.0.js.map", "{}")

      assert :not_found = load(dir)
    end
  end

  describe "envelope validation" do
    test "is the cache's, not the loader's: a well-formed but incomplete envelope loads",
         %{dir: dir} do
      envelope =
        Bundles.envelope("proofreadDocument")
        |> Map.drop(["digest", "timeoutMs"])

      Bundles.write_envelope!(dir, envelope)
      Bundles.write_code!(dir, "proofreadDocument", "1.0.0")

      assert {:ok, loaded, _code} = load(dir)
      assert loaded == envelope
    end
  end
end
