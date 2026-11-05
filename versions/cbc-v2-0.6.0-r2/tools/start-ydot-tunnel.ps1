param(
    [switch] $Check,
    [string] $TunnelId
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$runtime = Join-Path $PSScriptRoot 'ydot-tunnel-runtime.cjs'
& node $runtime --check
if ($LASTEXITCODE -ne 0) { throw 'Project binding check failed' }
if ($Check) { return }
$binding = Get-Content -LiteralPath (Join-Path $projectRoot '.local/ydot-secure-tunnel-20261031/binding.json') -Raw | ConvertFrom-Json
if ($binding.activationApproved -ne $true) { throw 'Cloud activation is paused pending account and scope review. No credentials requested.' }

# Protect only this project's dedicated state; do not change global security. / 只保护本项目专用状态，不更改全局安全设置。
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
foreach ($relative in @('.local/ydot-event-bridge-20261031', '.local/ydot-secure-tunnel-20261031', '.local/tunnel-client/v0.0.19')) {
    $directory = Get-Item -LiteralPath (Join-Path $projectRoot $relative)
    if ($directory.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Refuse state reparse point' }
    $acl = [System.Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($identity)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($identity, [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $directory.FullName -AclObject $acl
}
if (-not $TunnelId) {
    $binding = Get-Content -LiteralPath (Join-Path $projectRoot '.local/ydot-secure-tunnel-20261031/binding.json') -Raw | ConvertFrom-Json
    $TunnelId = $binding.tunnelId
}
if (-not $TunnelId) { $TunnelId = Read-Host 'Platform dedicated Tunnel ID (not an API key)' }
if ($TunnelId -notmatch '^tunnel_[A-Za-z0-9_-]{16,128}$') { throw 'Invalid Tunnel ID format' }
$secret = Read-Host 'Dedicated runtime key (Read + Use only; hidden input)' -AsSecureString
$pointer = [IntPtr]::Zero
try {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
    $runtimeKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    # Secrets travel through an anonymous stdin pipe, never command arguments or config files. / 秘密经匿名stdin管道传递，不进入命令参数或配置文件。
    $payload = @{ tunnelId = $TunnelId; runtimeKey = $runtimeKey } | ConvertTo-Json -Compress
    Write-Host 'Starting this project only. After readiness, connect the same Tunnel in ChatGPT Plugins.'
    Write-Host 'Keep this terminal open. Unsubscribe YDot before stopping this channel with Ctrl+C.'
    $payload | & node $runtime
    if ($LASTEXITCODE -ne 0) { throw "Runtime stopped with exit $LASTEXITCODE" }
} finally {
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    if ($secret) { $secret.Dispose() }
    $runtimeKey = $null
    $payload = $null
}
