#!/usr/bin/env bash
set -uo pipefail

run_root="${1:-/home/ec2-user/tlc}"
state_root="${TLC_STATE_ROOT:-/mnt/tlc}"
log_root="$run_root/logs"
jar="$run_root/tla2tools.jar"
model="$run_root/ChatLifecycle.tla"
digest_manifest="$run_root/SHA256SUMS"
jar_sha256=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
small_timeout=45m
strong_timeout=180m
kill_grace=2m

mkdir -p "$log_root" "$state_root"
ulimit -n 1048576 2>/dev/null || true

timestamp() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

shutdown_on_exit() {
  local exit_status=$?
  rm -f "$log_root/RUNNING"
  sync || true
  sudo shutdown -c >/dev/null 2>&1 || true
  sudo shutdown -h +15 "TLC run exited; collection grace period" || true
  return "$exit_status"
}

trap shutdown_on_exit EXIT

rm -f "$log_root/DONE" "$log_root/FAILED" "$log_root/small-results"
if ! (
  cd "$run_root"
  sha256sum --check --strict "$digest_manifest"
  printf '%s  %s\n' "$jar_sha256" "$jar" | sha256sum --check --strict
); then
  printf 'artifact_verification_failed_at=%s\n' "$(timestamp)" >"$log_root/FAILED"
  exit 2
fi

printf 'started_at=%s\n' "$(timestamp)" >"$log_root/RUNNING"

run_small() {
  local name="$1"
  local metadir="$state_root/small-$name"
  rm -rf "$metadir"
  mkdir -p "$metadir/tmp"
  (
    cd "$run_root"
    /usr/bin/time -v timeout --signal=INT --kill-after="$kill_grace" \
      "$small_timeout" java -Djava.io.tmpdir="$metadir/tmp" \
      -Xmx4g -XX:+UseParallelGC \
      -cp "$jar" tlc2.TLC \
      -config "$run_root/ChatLifecycle${name}.cfg" \
      -workers 8 -lncheck final -checkpoint 10 \
      -metadir "$metadir" "$model"
  ) >"$log_root/$name.log" 2>&1
}

names=(A B C D)
pids=()
for name in "${names[@]}"; do
  run_small "$name" &
  pids+=("$!")
done

small_failed=0
for index in "${!pids[@]}"; do
  if wait "${pids[$index]}"; then
    printf '%s=passed\n' "${names[$index]}" >>"$log_root/small-results"
  else
    printf '%s=failed\n' "${names[$index]}" >>"$log_root/small-results"
    small_failed=1
  fi
done

if ((small_failed != 0)); then
  printf 'small_model_failed_at=%s\n' "$(timestamp)" >"$log_root/FAILED"
else
  sync
  rm -rf "$state_root"/small-{A,B,C,D}
  rm -rf "$state_root/strong-states"
  mkdir -p "$state_root/strong-states/tmp"
  (
    cd "$run_root"
    /usr/bin/time -v timeout --signal=INT --kill-after="$kill_grace" \
      "$strong_timeout" java \
      -Djava.io.tmpdir="$state_root/strong-states/tmp" \
      -Xmx640g -XX:+UseParallelGC \
      -cp "$jar" tlc2.TLC \
      -config "$run_root/ChatLifecycle.cfg" \
      -workers 80 -lncheck final -checkpoint 10 -coverage 5 \
      -metadir "$state_root/strong-states" "$model"
  ) >"$log_root/strong.log" 2>&1
  strong_status=$?
  if ((strong_status == 0)); then
    printf 'completed_at=%s\n' "$(timestamp)" >"$log_root/DONE"
  else
    printf 'strong_exit=%s\nfailed_at=%s\n' \
      "$strong_status" "$(timestamp)" >"$log_root/FAILED"
  fi
fi
