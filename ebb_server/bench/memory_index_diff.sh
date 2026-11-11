#!/usr/bin/env bash
# C1 (#844): measure the log-first memory-index prototype.
#
# Every measured invocation runs under /tmp/spike-844-bench.lock, because this
# host has 4 schedulers and another spike child measures on it. The lock is
# taken per arm, not per rep, so the other child gets windows in between.
#
# Preflight (compile) and a smoke pass with tiny counts run before any lock;
# no file is edited once the first arm starts. Raw Markdown lands in
# bench/results/spike-844/.
#
#   ./bench/memory_index_diff.sh            # 3 interleaved reps
#   REPS=1 ./bench/memory_index_diff.sh     # one rep
#   ARMS="reads memory" ./bench/memory_index_diff.sh
#
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

LOCK=/tmp/spike-844-bench.lock
OUT=bench/results/spike-844
REPS=${REPS:-3}
ARMS=${ARMS:-"ack-b100 ack-b1000 ack-b100-prebuilt ack-b1000-prebuilt apply reads catch-up memory rebuild sqlite-write"}

mkdir -p "$OUT"

export MIX_ENV=dev
exec 9>"$LOCK"

# The pre-written block budget covers the whole pass with headroom: D3 measured
# b100 at ~51 KB per window and b1000 at ~510 KB, and an append that leaves the
# pre-written region pays block allocation again.
PREWRITE_B100=${PREWRITE_B100:-1700000000}
PREWRITE_B1000=${PREWRITE_B1000:-2100000000}

# Remove an arm's data dirs so /tmp does not fill across twelve ack passes.
cleanup() { rm -rf "${TMPDIR:-/tmp}"/ebb_spike_844_c1_* ; }

arm_code() {
  case "$1" in
    ack-b100)
      echo "ack(batch_size: 100, duration: 20, warmup: 3, prewrite_bytes: ${PREWRITE_B100})" ;;
    ack-b1000)
      echo "ack(batch_size: 1000, duration: 15, warmup: 3, prewrite_bytes: ${PREWRITE_B1000})" ;;
    ack-b100-prebuilt)
      echo "ack(batch_size: 100, duration: 20, warmup: 3, prewrite_bytes: ${PREWRITE_B100}, prebuilt: true)" ;;
    ack-b1000-prebuilt)
      echo "ack(batch_size: 1000, duration: 15, warmup: 3, prewrite_bytes: ${PREWRITE_B1000}, prebuilt: true)" ;;
    ack-b100-window)
      echo "ack(batch_size: 100, duration: 20, warmup: 3, prewrite_bytes: ${PREWRITE_B100}, shape: :window)" ;;
    ack-b1000-window)
      echo "ack(batch_size: 1000, duration: 15, warmup: 3, prewrite_bytes: ${PREWRITE_B1000}, shape: :window)" ;;
    apply)
      echo "apply(count: 100_000, window: 100)" ;;
    reads)
      echo "reads(count: 10_000)" ;;
    catch-up)
      echo "catch_up(count: 100_000, page: 100, samples: 500)" ;;
    memory)
      echo "memory(count: 100_000)" ;;
    rebuild)
      echo "rebuild(count: 100_000, page: 1_000)" ;;
    sqlite-write)
      echo "sqlite_write(count: 10_000, batch: 100)" ;;
    frame-io)
      echo "frame_io(batch_size: 1_000, windows: 300, prewrite_bytes: 600000000)" ;;
    *)
      echo "unknown arm: $1" >&2
      exit 1 ;;
  esac
}

smoke_code() {
  case "$1" in
    ack-b100 | ack-b1000 | ack-b100-prebuilt | ack-b1000-prebuilt | ack-b100-window | ack-b1000-window)
      echo "ack(batch_size: 10, duration: 0, warmup: 0, prewrite_bytes: 0)" ;;
    apply) echo "apply(count: 200, window: 100)" ;;
    reads) echo "reads(count: 50)" ;;
    catch-up) echo "catch_up(count: 200, page: 10, samples: 5)" ;;
    memory) echo "memory(count: 500)" ;;
    rebuild) echo "rebuild(count: 200, page: 100)" ;;
    sqlite-write) echo "sqlite_write(count: 100, batch: 10)" ;;
    frame-io) echo "frame_io(batch_size: 100, windows: 3, prewrite_bytes: 2000000)" ;;
  esac
}

run_code() {
  local code=$1
  mix run --no-start --no-compile -e \
    "EbbServer.Bench.MemoryIndexDiff.render(EbbServer.Bench.MemoryIndexDiff.${code}) |> IO.puts()"
}

run_arm() {
  local arm=$1 rep=$2 name="c1-$1-rep$2"
  local code
  code=$(arm_code "$arm")

  cleanup
  flock 9
  run_code "$code" | tee "$OUT/${name}.md"
  flock -u 9
  cleanup
}

echo "== preflight: compile (no lock held)"
mix compile

for arm in $ARMS; do
  echo "== smoke: $arm (no lock held, output discarded)"
  cleanup
  run_code "$(smoke_code "$arm")" >/dev/null
  cleanup
done

for rep in $(seq 1 "$REPS"); do
  echo
  echo "########## rep ${rep}/${REPS}"

  if [ $((rep % 2)) -eq 0 ]; then
    ordered=$(echo "$ARMS" | tr ' ' '\n' | tac | tr '\n' ' ')
  else
    ordered=$ARMS
  fi

  for arm in $ordered; do
    echo "---- ${arm} rep ${rep}"
    run_arm "$arm" "$rep"
  done
done

echo
echo "raw reports in ${OUT}/c1-*.md"
