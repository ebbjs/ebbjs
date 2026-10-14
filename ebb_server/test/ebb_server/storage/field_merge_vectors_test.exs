defmodule EbbServer.Storage.FieldMergeVectorsTest do
  @moduledoc """
  Cross-language conformance for the wire merge rule.

  Both `EbbServer.Storage.FieldMerge.merge/2` and `packages/core`'s
  `mergeFieldValue` must reproduce `fixtures/merge_vectors.json`, so the two
  hand-mirrored implementations cannot drift.
  """

  use ExUnit.Case, async: true

  alias EbbServer.Storage.FieldMerge

  @vectors_path Path.expand("../../../../fixtures/merge_vectors.json", __DIR__)

  test "reproduces every shared merge vector" do
    vectors =
      @vectors_path
      |> File.read!()
      |> Jason.decode!()
      |> Map.fetch!("vectors")

    assert vectors != [], "expected #{@vectors_path} to contain vectors"

    Enum.each(vectors, fn vector ->
      assert FieldMerge.merge(vector["existing"], vector["incoming"]) == vector["merged"],
             "vector #{inspect(vector["name"])} drifted"
    end)
  end
end
