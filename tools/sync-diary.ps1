# sync-diary.ps1 —— Windows 本机一键：把最新备份生成到本地预览目录（diary/data + diary/media）
#
# 方案 B（diary-contract.md「三·补三」）：日记数据不进仓库。
#   本脚本只写「已被 .gitignore 忽略」的本地预览目录，绝不把日记数据提交到 git。
#   真正的线上数据由 GitHub Actions 在构建时现拉现生成（见 .github/workflows/deploy.yml）。
#
# 常用：
#   .\tools\sync-diary.ps1                      # 找坚果云目录里最新的 zip → 生成到 diary/data
#   .\tools\sync-diary.ps1 -Serve               # 生成后起本地服务并打开 http://127.0.0.1:8080/diary/
#   .\tools\sync-diary.ps1 -Build               # 组装 _site/（等同于线上产物，用于自查）
#   .\tools\sync-diary.ps1 -Build -Serve        # 组装 _site/ 并起服务
#   .\tools\sync-diary.ps1 -IncludePrivate      # 连 Private 日记一起生成（仅本机自看）
#   .\tools\sync-diary.ps1 -PushCode            # 只提交「站点代码」改动并 push（先做数据泄漏检查）
#
# 注册计划任务（开机自动跑一次 / 每 30 分钟跑一次，仅生成本地预览）：
#   $ps1 = "F:\AI\Workspace\dsh\jialejunzi-site\tools\sync-diary.ps1"
#   $repo = "F:\AI\Workspace\dsh\jialejunzi-site"
#   # 开机：
#   schtasks /Create /TN "diary-sync-onstart" /SC ONSTART /RL LIMITED /F `
#     /TR "powershell -NoProfile -ExecutionPolicy Bypass -File `"$ps1`""
#   # 每 30 分钟：
#   schtasks /Create /TN "diary-sync-30m" /SC MINUTE /MO 30 /RL LIMITED /F `
#     /TR "powershell -NoProfile -ExecutionPolicy Bypass -File `"$ps1`""
#   # 删除：schtasks /Delete /TN "diary-sync-30m" /F
#   # 查看：schtasks /Query /TN "diary-sync-30m" /V /FO LIST

[CmdletBinding()]
param(
    [string]$LocalDir = (Join-Path $env:USERPROFILE 'Nutstore\1\SwashbucklerDiary'),
    [switch]$WebDav,
    [switch]$Build,
    [switch]$IncludePrivate,
    [switch]$Serve,
    [int]$Port = 8080,
    [switch]$PushCode
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Say "✗ 找不到 node。请先装 Node 24（https://nodejs.org/）——node:sqlite 需要 >= 22.5" 'Red'
    exit 1
}
$nodeVersion = (node -v)
Say "Node $nodeVersion｜仓库 $RepoRoot" 'DarkGray'

# ── 1) 取数据源 ─────────────────────────────────────────────
if ($WebDav) {
    if (-not $env:JIANGUO_USER -or -not $env:JIANGUO_PASS) {
        Say "✗ WebDAV 模式需要环境变量 JIANGUO_USER / JIANGUO_PASS（坚果云用「应用密码」）" 'Red'
        Say "  例如： `$env:JIANGUO_USER='you@example.com'; `$env:JIANGUO_PASS='应用密码'" 'Yellow'
        exit 1
    }
    $genArgs = @('--webdav')
} else {
    if (-not (Test-Path $LocalDir)) {
        Say "✗ 本机备份目录不存在：$LocalDir" 'Red'
        Say "  确认坚果云已把「我的坚果云\SwashbucklerDiary」同步到本机，或用 -LocalDir 指定。" 'Yellow'
        exit 1
    }
    $zip = Get-ChildItem -Path $LocalDir -Filter 'SwashbucklerDiaryBackup_*.zip' -File |
        Sort-Object -Property @{ Expression = {
            if ($_.Name -match 'SwashbucklerDiaryBackup_(\d{14})_') { $matches[1] } else { '0' } } } -Descending |
        Select-Object -First 1
    if (-not $zip) {
        Say "✗ $LocalDir 下没有 SwashbucklerDiaryBackup_*.zip" 'Red'
        Say "  先在手机 App 里做一次 WebDAV 备份，等坚果云同步下来。" 'Yellow'
        exit 1
    }
    Say "最新备份：$($zip.Name)（$([math]::Round($zip.Length / 1KB, 1)) KB，$($zip.LastWriteTime)）" 'Cyan'
    $genArgs = @('--local', '--dir', $LocalDir)
}

if ($IncludePrivate) { $genArgs += '--include-private' }

# ── 2) 生成 ─────────────────────────────────────────────────
if ($Build) {
    $target = Join-Path $RepoRoot '_site'
    Say "`n▶ 组装生产产物 _site/ ..." 'Green'
    & node (Join-Path $PSScriptRoot 'build-site.mjs') @genArgs --out $target
} else {
    Say "`n▶ 生成本地预览数据 diary/data + diary/media ..." 'Green'
    # 不传 --out：默认写仓库根的 diary/data、diary/media（已被 .gitignore 忽略）
    & node (Join-Path $PSScriptRoot 'sync-diary.mjs') @genArgs
}
$code = $LASTEXITCODE
if ($code -ne 0) { Say "`n✗ 生成失败（退出码 $code）" 'Red'; exit $code }

# ── 3) 数据泄漏自检：日记数据绝不能被 git 跟踪 ─────────────────
Say "`n▶ 检查日记数据是否会被 git 提交 ..." 'Green'
$leak = git status --porcelain -uall | Where-Object { $_ -match 'diary/(data|media)/' -or $_ -match '^\?\? _site/' -or $_ -match '^\?\?.*\.zip$' }
if ($leak) {
    Say "✗ 发现本不该被提交的路径（.gitignore 可能被改坏了）：" 'Red'
    $leak | ForEach-Object { Say "   $_" 'Red' }
    exit 2
}
Say "  ✓ 干净：diary/data、diary/media、_site 都不会进 git" 'Green'

# ── 4) 起本地服务预览 ───────────────────────────────────────
if ($Serve) {
    $root = if ($Build) { Join-Path $RepoRoot '_site' } else { $RepoRoot }
    $url = "http://127.0.0.1:$Port/diary/"
    Say "`n▶ 本地预览：$url  （根目录 $root，Ctrl+C 停止）" 'Green'
    Start-Process $url | Out-Null
    $py = Get-Command python -ErrorAction SilentlyContinue
    if ($py) { & python -m http.server $Port --directory $root }
    else {
        Say "  没找到 python，改用 npx serve ..." 'Yellow'
        & npx --yes serve -l $Port $root
    }
    exit 0
}

# ── 5) 可选：只推进「站点代码」改动 ────────────────────────────
if ($PushCode) {
    Say "`n▶ 提交并推送站点代码改动（绝不包含日记数据）..." 'Green'
    $staged = git diff --cached --name-only
    if ($staged -match 'diary/(data|media)/|^_site/') {
        Say "✗ 暂存区里有日记数据，拒绝提交。先 git reset 相关路径。" 'Red'
        exit 2
    }
    git add -A -- . ':!diary/data' ':!diary/media' ':!_site'
    $now = Get-Date -Format 'yyyy-MM-dd HH:mm'
    git commit -m "chore(site): 更新站点代码 $now" | Out-Null
    if ($LASTEXITCODE -ne 0) { Say "  没有需要提交的改动" 'Yellow'; exit 0 }
    git push
    Say "  ✓ 已推送（数据仍在本地，线上由 Actions 现场生成）" 'Green'
    exit 0
}

Say "`n完成。想看效果：.\tools\sync-diary.ps1 -Serve  （或 python -m http.server 后访问 /diary/）" 'Cyan'
