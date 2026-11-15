#!/bin/sh
# 采集代理进程资源采样器（在被测主机上运行，POSIX sh）。
#
# 用法：sample-proxy.sh [持续秒数=60]
# 每秒采样一次 /proc/<pid>：CPU%（utime+stime 增量）、RSS(MB)、打开 fd 数；
# 输出 CSV 到 stdout（t,cpu_percent,rss_mb,fd_count），末行打印汇总。
# 用法示例（在负载运行的同时采样 180 秒）：
#   ssh root@<目标机> 'sh -s 180' < tests/load/sample-proxy.sh > results/proxy-sample.csv
set -eu

duration=${1:-60}
pid=$(systemctl show -p MainPID --value new-api-dashcam)
if [ -z "$pid" ] || [ "$pid" = "0" ]; then
    echo "new-api-dashcam 未运行（MainPID 为空）" >&2
    exit 2
fi
clk=$(getconf CLK_TCK)

read_stat() {
    # comm 为单 token（new-api-dashcam），utime/stime 为第 14/15 字段，rss 第 24 字段
    awk '{print $14 + $15, $24}' "/proc/$pid/stat"
}

prev=$(read_stat)
prev_t=$(date +%s.%N)
echo "t,cpu_percent,rss_mb,fd_count"

sum=0
peak_rss=0
fd_min=999999
fd_max=0
t=0
while [ "$t" -lt "$duration" ]; do
    sleep 1
    t=$((t + 1))
    cur=$(read_stat)
    cur_t=$(date +%s.%N)
    cpu=$(awk -v p="$prev" -v c="$cur" -v pt="$prev_t" -v ct="$cur_t" -v clk="$clk" 'BEGIN {
        split(p, a, " "); split(c, b, " ");
        printf "%.1f", (b[1] - a[1]) / clk / (ct - pt) * 100
    }')
    rss_pages=$(echo "$cur" | awk "{print \$2}")
    rss=$(awk -v p="$rss_pages" 'BEGIN { printf "%.1f", p * 4096 / 1048576 }')
    fd=$(ls "/proc/$pid/fd" 2>/dev/null | wc -l)
    echo "$t,$cpu,$rss,$fd"
    sum=$(awk -v a="$sum" -v b="$cpu" 'BEGIN { printf "%.2f", a + b }')
    if [ "$(awk -v a="$rss" -v b="$peak_rss" 'BEGIN { print (a > b) }')" = "1" ]; then
        peak_rss=$rss
    fi
    if [ "$fd" -lt "$fd_min" ]; then fd_min=$fd; fi
    if [ "$fd" -gt "$fd_max" ]; then fd_max=$fd; fi
    prev=$cur
    prev_t=$cur_t
done

avg=$(awk -v a="$sum" -v n="$duration" 'BEGIN { printf "%.1f", a / n }')
echo "# 汇总: 平均 CPU ${avg}% · RSS 峰值 ${peak_rss}MB · fd ${fd_min}~${fd_max}"
