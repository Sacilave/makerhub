param(
    [ValidateSet("start","stop","restart","status","logs","doctor","password","update")]
    [string]$Command = "start",
    [switch]$NoOpen
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root
$Compose = Join-Path $Root "compose.yaml"
$EnvFile = Join-Path $Root ".env"
$SecretsDir = Join-Path $Root "secrets"
$StateKey = Join-Path $SecretsDir "state-encryption-key"
$PreviousKeys = Join-Path $SecretsDir "state-encryption-previous-keys"
$BaseUrl = "http://127.0.0.1:9042"

function Write-Info([string]$Message) { Write-Host "[MakerHub] $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message) { Write-Host "[MakerHub] $Message" -ForegroundColor Green }
function Write-WarnText([string]$Message) { Write-Host "[MakerHub] $Message" -ForegroundColor Yellow }
function New-RandomBytes([int]$Count) { $bytes = New-Object byte[] $Count; $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create(); try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }; return $bytes }
function New-HexSecret([int]$Count = 32) { return ([System.BitConverter]::ToString((New-RandomBytes $Count))).Replace("-", "").ToLowerInvariant() }
function New-UrlSafeKey { $text = [Convert]::ToBase64String((New-RandomBytes 32)); return $text.TrimEnd("=").Replace("+","-").Replace("/","_") }
function Test-Docker {
    if (-not [Environment]::Is64BitOperatingSystem) { throw "Windows Release 仅支持 64 位 x86-64 (amd64) Windows。" }
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw "未找到 Docker。请先安装并启动 Docker Desktop。" }
    & docker compose version *> $null; if ($LASTEXITCODE -ne 0) { throw "Docker Compose v2 不可用。" }
    & docker version --format "{{.Server.Version}}" *> $null; if ($LASTEXITCODE -ne 0) { throw "Docker Engine 未运行。请启动 Docker Desktop 后重试。" }
}
function Ensure-Secrets {
    if (-not (Test-Path $SecretsDir)) { New-Item -ItemType Directory -Path $SecretsDir | Out-Null }
    if (-not (Test-Path $EnvFile)) {
        $pg = New-HexSecret 32; $cb = New-HexSecret 32
        @"
MAKERHUB_POSTGRES_PASSWORD=$pg
MAKERHUB_CLOAKBROWSER_AUTH_TOKEN=$cb
MAKERHUB_BIND_ADDRESS=127.0.0.1
MAKERHUB_AUTO_VERIFY_3MF=false
TZ=Asia/Shanghai
"@ | Set-Content -Path $EnvFile -Encoding ASCII
        Write-Ok "已生成 .env"
    }
    if (-not (Test-Path $StateKey)) { ("base64:" + (New-UrlSafeKey)) | Set-Content -Path $StateKey -Encoding ASCII -NoNewline; Write-Ok "已生成 AES-256 状态加密主密钥" }
    if (-not (Test-Path $PreviousKeys)) { New-Item -ItemType File -Path $PreviousKeys | Out-Null }
}
function Wait-Ready([int]$TimeoutSeconds = 180) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try { $response = Invoke-WebRequest -Uri "$BaseUrl/api/public/health/ready" -UseBasicParsing -TimeoutSec 3; if ($response.StatusCode -eq 200) { Write-Ok "服务已就绪：$BaseUrl"; return } } catch {}
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
    & docker compose -f $Compose ps
    throw "MakerHub 在 $TimeoutSeconds 秒内未进入 ready 状态。请运行 .\makerhub.ps1 logs 查看日志。"
}
function Show-BootstrapPassword {
    $password = (& docker compose -f $Compose exec -T makerhub-app sh -lc "cat /app/config/state/admin-bootstrap-password 2>/dev/null || true").Trim()
    if ($password) { Write-Host ""; Write-Host "首次登录用户名：admin" -ForegroundColor White; Write-Host "一次性密码：$password" -ForegroundColor Yellow; Write-Host "登录后请立即修改密码。" -ForegroundColor Yellow }
    else { Write-Info "未发现一次性密码文件；如果已经修改过管理员密码，这是正常的。" }
}
function Invoke-Doctor {
    Test-Docker; Ensure-Secrets; Write-Info "Docker / Compose：OK"
    & docker compose -f $Compose config --quiet; if ($LASTEXITCODE -ne 0) { throw "compose.yaml 校验失败。" }; Write-Info "Compose 配置：OK"
    & docker compose -f $Compose ps
    try { $response = Invoke-WebRequest -Uri "$BaseUrl/api/public/health/ready" -UseBasicParsing -TimeoutSec 5; if ($response.StatusCode -eq 200) { Write-Ok "App readiness：OK" } } catch { Write-WarnText "App readiness：未就绪" }
    & docker compose -f $Compose exec -T makerhub-worker python -m app.worker --healthcheck *> $null; if ($LASTEXITCODE -eq 0) { Write-Ok "Worker heartbeat：OK" } else { Write-WarnText "Worker heartbeat：失败" }
    & docker compose -f $Compose exec -T makerhub-postgres pg_isready -U makerhub -d makerhub *> $null; if ($LASTEXITCODE -eq 0) { Write-Ok "PostgreSQL：OK" } else { Write-WarnText "PostgreSQL：失败" }
    & docker compose -f $Compose exec -T makerhub-app python -c "import socket; s=socket.create_connection(('cloakbrowser',8080),5); s.close()" *> $null; if ($LASTEXITCODE -eq 0) { Write-Ok "CloakBrowser network：OK" } else { Write-WarnText "CloakBrowser network：失败" }
}

Test-Docker
Ensure-Secrets

switch ($Command) {
    "start" { Write-Info "拉取已验证的 Release 镜像..."; & docker compose -f $Compose pull; if ($LASTEXITCODE -ne 0) { throw "镜像拉取失败。" }; Write-Info "启动 MakerHub..."; & docker compose -f $Compose up -d; if ($LASTEXITCODE -ne 0) { throw "Docker Compose 启动失败。" }; Wait-Ready; Show-BootstrapPassword; if (-not $NoOpen) { Start-Process $BaseUrl } }
    "stop" { & docker compose -f $Compose down }
    "restart" { & docker compose -f $Compose restart; Wait-Ready }
    "status" { & docker compose -f $Compose ps }
    "logs" { & docker compose -f $Compose logs -f makerhub-app makerhub-worker }
    "doctor" { Invoke-Doctor }
    "password" { Show-BootstrapPassword }
    "update" { Write-Info "当前 Release 包固定到已验证镜像；update 仅重新拉取同一镜像并重建容器。"; & docker compose -f $Compose pull; if ($LASTEXITCODE -ne 0) { throw "镜像拉取失败。" }; & docker compose -f $Compose up -d; if ($LASTEXITCODE -ne 0) { throw "更新失败。" }; Wait-Ready }
}
