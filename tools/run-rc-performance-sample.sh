#!/usr/bin/env bash
set -u

if [[ $# -ne 5 ]]; then
  echo "usage: $0 <app-binary> <tabs> <sample-id> <idle-ms> <output-dir>" >&2
  exit 2
fi

app_binary=$1
tabs=$2
sample_id=$3
idle_ms=$4
output_dir=$5
timeout_ms=${TABVERSE_RUNTIME_PERFORMANCE_TIMEOUT_MS:-120000}

mkdir -p "$output_dir"
sample_root=$(mktemp -d "${TMPDIR:-/tmp}/tabverse-rc-performance-${tabs}-${sample_id}.XXXXXX")
cleanup() {
  if [[ "$sample_root" == "${TMPDIR:-/tmp}"/tabverse-rc-performance-* ]]; then
    for _attempt in 1 2 3; do
      rm -rf -- "$sample_root" 2>/dev/null && break
      sleep 0.2
    done
  fi
}
trap cleanup EXIT

mkdir -p "$sample_root/app-data" "$sample_root/root-cache"
: >"$sample_root/config.toml"
log_file="$output_dir/cef-${tabs}-${sample_id}.log"
process_file="$output_dir/cef-${tabs}-${sample_id}-process.tsv"

TABVERSE_RUNTIME_PERFORMANCE_ACCEPTANCE=1 \
TABVERSE_RUNTIME_PERFORMANCE_TABS="$tabs" \
TABVERSE_RUNTIME_PERFORMANCE_IDLE_MS="$idle_ms" \
TABVERSE_RUNTIME_PERFORMANCE_BETWEEN_TABS_MS=2000 \
TABVERSE_ACCEPTANCE_APP_DATA_DIR="$sample_root/app-data" \
TABVERSE_ACCEPTANCE_ROOT_CACHE="$sample_root/root-cache" \
TABVERSE_CONFIG_FILE="$sample_root/config.toml" \
TABVERSE_CEF_POC_TRACE_SHUTDOWN=1 \
  "$app_binary" >"$log_file" 2>&1 &

app_pid=$!
started_ms=$(perl -MTime::HiRes=time -e 'printf "%.0f\n", time * 1000')
printf 'elapsed_ms\tprocesses\trss_kb\tcpu_seconds\n' >"$process_file"
peak_rss_kb=0
peak_processes=0
forced=0

while kill -0 "$app_pid" 2>/dev/null; do
  process_state=$(ps -o state= -p "$app_pid" | tr -d ' ')
  if [[ "$process_state" == Z* ]]; then
    break
  fi
  now_ms=$(perl -MTime::HiRes=time -e 'printf "%.0f\n", time * 1000')
  elapsed_ms=$((now_ms - started_ms))
  snapshot=$(
    ps -axo pid=,ppid=,rss=,time= | awk -v root="$app_pid" '
      function cpu_seconds(value, parts, n, day_parts, days, seconds) {
        days = 0
        if (index(value, "-") > 0) {
          split(value, day_parts, "-")
          days = day_parts[1]
          value = day_parts[2]
        }
        n = split(value, parts, ":")
        seconds = parts[n]
        if (n >= 2) seconds += parts[n - 1] * 60
        if (n >= 3) seconds += parts[n - 2] * 3600
        return days * 86400 + seconds
      }
      {
        pid[NR] = $1
        ppid[NR] = $2
        rss[NR] = $3
        cpu[NR] = cpu_seconds($4)
      }
      END {
        owned[root] = 1
        changed = 1
        while (changed) {
          changed = 0
          for (i = 1; i <= NR; i++) {
            if (!owned[pid[i]] && owned[ppid[i]]) {
              owned[pid[i]] = 1
              changed = 1
            }
          }
        }
        count = 0
        total_rss = 0
        total_cpu = 0
        for (i = 1; i <= NR; i++) {
          if (owned[pid[i]]) {
            count++
            total_rss += rss[i]
            total_cpu += cpu[i]
          }
        }
        printf "%d %d %.2f\n", count, total_rss, total_cpu
      }
    '
  )
  read -r process_count rss_kb cpu_seconds <<<"$snapshot"
  printf '%s\t%s\t%s\t%s\n' "$elapsed_ms" "$process_count" "$rss_kb" "$cpu_seconds" >>"$process_file"
  (( rss_kb > peak_rss_kb )) && peak_rss_kb=$rss_kb
  (( process_count > peak_processes )) && peak_processes=$process_count

  if (( elapsed_ms >= timeout_ms )); then
    forced=1
    kill -TERM "$app_pid" 2>/dev/null || true
    sleep 1
    kill -KILL "$app_pid" 2>/dev/null || true
    break
  fi
  sleep 0.25
done

wait "$app_pid"
exit_code=$?
ended_ms=$(perl -MTime::HiRes=time -e 'printf "%.0f\n", time * 1000')
wall_ms=$((ended_ms - started_ms))
marker_ms() {
  local marker=$1
  local position=${2:-first}
  local line
  if [[ "$position" == "last" ]]; then
    line=$(rg "$marker" "$log_file" | tail -1 || true)
  else
    line=$(rg "$marker" "$log_file" | head -1 || true)
  fi
  sed -E 's/.*elapsed_ms=([0-9]+).*/\1/' <<<"$line"
}

setup_ms=$(marker_ms 'TABVERSE_RUNTIME_PERFORMANCE_SETUP')
first_create_ms=$(marker_ms 'TABVERSE_RUNTIME_PERFORMANCE_CREATE index=1')
first_ready_ms=$(marker_ms 'TABVERSE_RUNTIME_PERFORMANCE_READY index=1')
second_create_ms=$(marker_ms 'TABVERSE_RUNTIME_PERFORMANCE_CREATE index=2')
second_ready_ms=$(marker_ms 'TABVERSE_RUNTIME_PERFORMANCE_READY index=2')
all_ready_ms=$(marker_ms 'TABVERSE_RUNTIME_PERFORMANCE_ALL_READY' last)
request_exit_ms=$(marker_ms 'TABVERSE_RUNTIME_PERFORMANCE_REQUEST_EXIT' last)
exit_ms=$(marker_ms 'TABVERSE_RUNTIME_PERFORMANCE_EXIT elapsed_ms=' last)
ready_count=$(rg -c 'TABVERSE_RUNTIME_PERFORMANCE_READY index=' "$log_file" || true)
all_ready_count=$(rg -c 'TABVERSE_RUNTIME_PERFORMANCE_ALL_READY' "$log_file" || true)
idle_cpu_percent=$(awk -v start="$all_ready_ms" -v end="$request_exit_ms" '
  NR > 1 && $1 <= start { start_elapsed = $1; start_cpu = $4 }
  NR > 1 && $1 <= end { end_elapsed = $1; end_cpu = $4 }
  END {
    duration = end_elapsed - start_elapsed
    if (duration > 0) printf "%.2f", (end_cpu - start_cpu) * 100000 / duration
    else print "0.00"
  }
' "$process_file")
second_rss_delta_kb=""
if [[ -n "$second_create_ms" && -n "$request_exit_ms" ]]; then
  second_baseline_rss_kb=$(awk -v cutoff="$second_create_ms" 'NR > 1 && $1 <= cutoff { value = $3 } END { print value + 0 }' "$process_file")
  second_peak_rss_kb=$(awk -v start="$second_create_ms" -v end="$request_exit_ms" 'NR > 1 && $1 >= start && $1 <= end && $3 > value { value = $3 } END { print value + 0 }' "$process_file")
  second_rss_delta_kb=$((second_peak_rss_kb - second_baseline_rss_kb))
  (( second_rss_delta_kb < 0 )) && second_rss_delta_kb=0
fi

printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
  "cef" "$tabs" "$sample_id" "$exit_code" "$forced" "$setup_ms" \
  "$first_create_ms" "$first_ready_ms" "$second_create_ms" "$second_ready_ms" \
  "$all_ready_ms" "$request_exit_ms" "$exit_ms" "$wall_ms" "$second_rss_delta_kb" "$peak_rss_kb" \
  "$idle_cpu_percent"

if [[ "$exit_code" -ne 0 || "$forced" -ne 0 || "$ready_count" -ne "$tabs" || "$all_ready_count" -ne 1 ]]; then
  exit 1
fi
