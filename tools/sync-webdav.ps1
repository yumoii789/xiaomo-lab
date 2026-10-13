#Requires -Version 5.1
<#
  小墨实验室 —— WebDAV 同步工具
  把本地项目目录镜像到 WebDAV 服务器。

  用法：
    pwsh -File tools\sync-webdav.ps1              # 增量同步（只传有变化的）
    pwsh -File tools\sync-webdav.ps1 -Full        # 全量同步
    pwsh -File tools\sync-webdav.ps1 -DryRun      # 只列出将要上传的文件
#>
[CmdletBinding()]
param(
    [string]$Config,
    [switch]$Full,
    [switch]$DryRun
)

$ErrorActionPreference = 'Continue'

# $PSScriptRoot 在 param 默认值中求值为空（PS 5.1 的坑），必须在这里解析
if (-not $Config) { $Config = Join-Path $PSScriptRoot 'sync.config.json' }
$Config = [System.IO.Path]::GetFullPath($Config)
if (-not (Test-Path -LiteralPath $Config)) { throw "找不到配置文件: $Config" }
$cfg = Get-Content -LiteralPath $Config -Raw -Encoding UTF8 | ConvertFrom-Json

$baseUrl = ([string]$cfg.baseUrl).TrimEnd('/')
$remote  = ([string]$cfg.remoteDir).Trim('/')
$root    = (Resolve-Path -LiteralPath $cfg.localDir).Path
$auth    = "$($cfg.user):$($cfg.password)"
$exclude = @($cfg.exclude)
$stateFile = Join-Path $PSScriptRoot '.sync-state.json'

function Test-Excluded([string]$rel) {
    $leaf = Split-Path $rel -Leaf
    foreach ($e in $exclude) {
        if ($rel -eq $e) { return $true }
        if ($leaf -like $e) { return $true }
        if ($rel -like "$e/*" -or $rel -like "*/$e/*") { return $true }
    }
    return $false
}

function Get-Url([string]$rel) {
    $parts = $rel -split '/' | ForEach-Object { [uri]::EscapeDataString($_) }
    return "$baseUrl/$remote/" + ($parts -join '/')
}

function New-DavDir([string]$url) {
    & curl.exe -sS --max-time 60 -u $auth -X MKCOL $url *> $null
    # 201 = 创建成功, 405 = 已存在 —— 都算正常
    return ($LASTEXITCODE -eq 0)
}

function Send-DavFile([string]$url, [string]$path) {
    & curl.exe -sS --max-time 300 -u $auth -T $path $url *> $null
    return ($LASTEXITCODE -eq 0)
}

# ── 收集本地文件 ──────────────────────────────────────────────
$dirs  = New-Object System.Collections.Generic.List[string]
$files = New-Object System.Collections.Generic.List[object]

Get-ChildItem -LiteralPath $root -Recurse -Force -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $rel = $_.FullName.Substring($root.Length + 1) -replace '\\', '/'
    if (-not (Test-Excluded $rel)) { $dirs.Add($rel) }
}
Get-ChildItem -LiteralPath $root -Recurse -Force -File -ErrorAction SilentlyContinue | ForEach-Object {
    $rel = $_.FullName.Substring($root.Length + 1) -replace '\\', '/'
    if (Test-Excluded $rel) { return }
    $files.Add([pscustomobject]@{
        Rel   = $rel
        Path  = $_.FullName
        Size  = $_.Length
        Stamp = "$($_.LastWriteTimeUtc.Ticks)-$($_.Length)"
    })
}

# ── 增量判断 ──────────────────────────────────────────────────
$state = @{}
if (-not $Full -and (Test-Path -LiteralPath $stateFile)) {
    try {
        $raw = Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
        foreach ($p in $raw.PSObject.Properties) { $state[$p.Name] = $p.Value }
    } catch { }
}

$pending = @($files | Where-Object { $Full -or $state[$_.Rel] -ne $_.Stamp })

if ($DryRun) {
    Write-Host "[DryRun] 目录 $($dirs.Count) 个, 文件 $($files.Count) 个, 待上传 $($pending.Count) 个" -ForegroundColor Cyan
    $pending | ForEach-Object { Write-Host ("  -> " + $_.Rel) }
    return
}

Write-Host "小墨实验室 -> WebDAV 同步" -ForegroundColor Cyan
Write-Host "  远端: $baseUrl/$remote/"
Write-Host "  本地: $root"
Write-Host "  文件: $($files.Count) 个 (待传 $($pending.Count))" -ForegroundColor Gray
Write-Host ""

# ── 建目录 ────────────────────────────────────────────────────
New-DavDir "$baseUrl/$remote" | Out-Null
foreach ($d in $dirs) { New-DavDir (Get-Url $d) | Out-Null }
Write-Host "  目录结构已就绪 ($($dirs.Count + 1) 个)" -ForegroundColor DarkGray

# ── 上传 ──────────────────────────────────────────────────────
$ok = 0; $bad = 0; $total = [long]0
foreach ($f in $pending) {
    $url = Get-Url $f.Rel
    if (Send-DavFile $url $f.Path) {
        $ok++; $total += $f.Size
        $state[$f.Rel] = $f.Stamp
        Write-Host ("  [OK]   {0,-46} {1,8:N0} B" -f $f.Rel, $f.Size) -ForegroundColor Green
    } else {
        $bad++
        Write-Host ("  [FAIL] " + $f.Rel) -ForegroundColor Red
    }
}

# ── 保存同步状态 ──────────────────────────────────────────────
$json = $state | ConvertTo-Json -Depth 3
[System.IO.File]::WriteAllText($stateFile, $json, (New-Object System.Text.UTF8Encoding($false)))

Write-Host ""
if ($bad -eq 0) {
    Write-Host "  同步完成: $ok 个文件, $([math]::Round($total/1KB,1)) KB" -ForegroundColor Cyan
} else {
    Write-Host "  同步结束: 成功 $ok, 失败 $bad" -ForegroundColor Yellow
}
Write-Host "  位置: $baseUrl/$remote/" -ForegroundColor Gray
exit $(if ($bad -eq 0) { 0 } else { 1 })
