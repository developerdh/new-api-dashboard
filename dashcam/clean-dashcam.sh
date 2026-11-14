#!/bin/sh
# clean-dashcam.sh — new-api-dashcam 采集产物按保留期清理（D-P1）
#
# 设计依据：docs/dashcam/06-performance-plan.md §14（结论与安全要求）、02-design.md §6.3。
#
# 用法：
#   clean-dashcam.sh [--confirm] [DASHCAM_DIR]
#
# 环境变量：
#   DASHCAM_DIR             记录根目录（与代理一致；位置参数优先）
#   DASHCAM_RETENTION_DAYS  保留天数，默认 90；0 = 禁用清理（直接退出）
#
# 行为：
#   1. 删除早于保留期的 blobs/<YYYY-MM-DD>/ 整目录与 index/<YYYY-MM-DD>.ndjson；
#      过期与否按目录/文件名中的日期判定（不看 mtime），ISO 日期字典序比较；
#   2. 回收 blobs/ 与 index/ 下的 *.tmp 残留（采集中断产物，含压缩中间态 .gz.tmp），
#      残留回收不区分日期；段式布局（blobs/<date>/<fp>/seg-*.pack）位于日期目录内部，
#      整目录删除天然覆盖，无需单独处理；
#   3. 非 YYYY-MM-DD 命名的目录/文件一律不动，逐条提示人工确认。
#
# 安全：
#   - 默认 dry-run：只打印待删清单与体积，不做任何改动；
#   - 实际删除需显式加 --confirm；
#   - 全部待删路径由脚本按 DASHCAM_DIR 构造并经日期格式校验，不接收外部路径。

set -eu

confirm=0
if [ "${1:-}" = "--confirm" ]; then
    confirm=1
    shift
fi
if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
    sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
fi

dir="${1:-${DASHCAM_DIR:-}}"
if [ -z "$dir" ]; then
    echo "用法: clean-dashcam.sh [--confirm] [DASHCAM_DIR]" >&2
    echo "未指定目录：传位置参数或设 DASHCAM_DIR 环境变量" >&2
    exit 2
fi
if [ "$dir" = "/" ] || [ ! -d "$dir" ]; then
    echo "错误: DASHCAM_DIR 必须是已存在的目录（当前: $dir）" >&2
    exit 2
fi

days="${DASHCAM_RETENTION_DAYS:-90}"
case "$days" in
    '' | *[!0-9]*)
        echo "错误: DASHCAM_RETENTION_DAYS 必须是非负整数（当前: $days）" >&2
        exit 2
        ;;
esac
if [ "$days" -eq 0 ]; then
    echo "清理已禁用（DASHCAM_RETENTION_DAYS=0），未做任何改动"
    exit 0
fi
if [ "$days" -le 31 ]; then
    echo "警告: 保留期 ${days} 天不大于看板查询窗口上限（DASHCAM_MAX_WINDOW_DAYS 默认 31），可能删掉看板仍在查询的数据" >&2
fi

blobs="$dir/blobs"
index="$dir/index"
if [ ! -d "$blobs" ] && [ ! -d "$index" ]; then
    echo "错误: $dir 下既无 blobs/ 也无 index/，不像 new-api-dashcam 记录目录" >&2
    exit 2
fi

# 保留期边界：今天 - days 天（GNU date）。ISO 日期可直接按字典序比较，无需逐目录换算。
if ! cutoff=$(date -d "$days days ago" +%F 2>/dev/null); then
    echo "错误: 当前环境的 date 不支持 -d（需要 GNU date）" >&2
    exit 2
fi

# date_class <name> → 0=已过期 1=未过期 2=非日期命名
date_class() {
    case "$1" in
        [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) ;;
        *) return 2 ;;
    esac
    if awk 'BEGIN { exit !(ARGV[1] < ARGV[2]) }' "$1" "$cutoff"; then
        return 0
    fi
    return 1
}

if [ "$confirm" -eq 1 ]; then
    mode="删除（--confirm）"
else
    mode="dry-run（加 --confirm 才实际删除）"
fi
echo "记录目录: $dir"
echo "保留期:   $days 天（清理早于 $cutoff 的日期）"
echo "模式:     $mode"
echo

dirs_total=0
files_total=0
tmp_total=0
dirs_kb=0
skipped=0

# 1) 过期的日期目录（含段式打包布局：blobs/<date>/<fp>/seg-*.pack 随整目录删除）
for d in "$blobs"/*/; do
    [ -d "$d" ] || continue
    name=$(basename "$d")
    cls=0
    date_class "$name" || cls=$?
    if [ "$cls" -eq 2 ]; then
        echo "跳过（非日期命名，请人工确认）: blobs/$name" >&2
        skipped=$((skipped + 1))
        continue
    fi
    if [ "$cls" -ne 0 ]; then
        continue
    fi
    size_kb=$(du -sk "$d" 2>/dev/null | cut -f1)
    size_kb=${size_kb:-0}
    echo "待删: blobs/$name/  ${size_kb} KB"
    dirs_total=$((dirs_total + 1))
    dirs_kb=$((dirs_kb + size_kb))
    if [ "$confirm" -eq 1 ]; then
        rm -rf "$d"
    fi
done

# 2) 同寿命的日索引文件
for f in "$index"/*.ndjson; do
    [ -f "$f" ] || continue
    name=$(basename "$f" .ndjson)
    cls=0
    date_class "$name" || cls=$?
    if [ "$cls" -eq 2 ]; then
        echo "跳过（非日期命名，请人工确认）: index/$(basename "$f")" >&2
        skipped=$((skipped + 1))
        continue
    fi
    if [ "$cls" -ne 0 ]; then
        continue
    fi
    size_kb=$(du -k "$f" 2>/dev/null | cut -f1)
    size_kb=${size_kb:-0}
    echo "待删: index/$(basename "$f")  ${size_kb} KB"
    files_total=$((files_total + 1))
    dirs_kb=$((dirs_kb + size_kb))
    if [ "$confirm" -eq 1 ]; then
        rm -f "$f"
    fi
done

# 3) *.tmp 残留（不区分日期；按换行分词即可——本目录布局不含空格路径）
tmp_list=""
if [ -d "$blobs" ] || [ -d "$index" ]; then
    tmp_list=$(find "$blobs" "$index" -type f -name '*.tmp' 2>/dev/null || true)
fi
if [ -n "$tmp_list" ]; then
    old_ifs=$IFS
    IFS='
'
    for f in $tmp_list; do
        echo "待删: ${f#"$dir"/}  （采集中断残留）"
        tmp_total=$((tmp_total + 1))
        if [ "$confirm" -eq 1 ]; then
            rm -f "$f"
        fi
    done
    IFS=$old_ifs
fi

echo
size_kb=${dirs_kb}KB
if [ "$dirs_kb" -ge 1024 ]; then
    size_kb="$((dirs_kb / 1024))MB"
fi
if [ "$confirm" -eq 1 ]; then
    echo "已删除: ${dirs_total} 个日期目录 + ${files_total} 个索引文件 + ${tmp_total} 个 .tmp 残留，回收约 ${size_kb}"
else
    echo "共 ${dirs_total} 个日期目录 + ${files_total} 个索引文件 + ${tmp_total} 个 .tmp 残留，约 ${size_kb}"
    echo "dry-run 未删除任何内容；确认无误后加 --confirm 执行"
fi
if [ "$skipped" -gt 0 ]; then
    echo "另有 ${skipped} 个非日期命名的条目被跳过，请人工处理" >&2
fi
