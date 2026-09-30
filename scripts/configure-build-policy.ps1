param([Parameter(Mandatory=$true)][string]$ProfileDir)
$ErrorActionPreference = 'Stop'
$policyPath = Join-Path $ProfileDir 'pnpm-workspace.yaml'
if (-not (Test-Path -LiteralPath $ProfileDir)) {
    New-Item -ItemType Directory -Path $ProfileDir -Force | Out-Null
}
$content = if (Test-Path -LiteralPath $policyPath) { [IO.File]::ReadAllText($policyPath) } else { '' }
$section = [regex]::Match($content, '(?m)^allowBuilds:[^\r\n]*(?:\r?\n(?:(?:[ \t]+[^\r\n]*)|(?:#[^\r\n]*)|(?:[ \t]*)))*')
if ($section.Success) {
    if ($section.Value.Split("`n")[0] -notmatch '^allowBuilds:\s*(?:#.*)?$') {
        throw 'Unsupported inline allowBuilds mapping. Use a YAML block mapping before packaging.'
    }
    $rule = [regex]::Match($section.Value, '(?m)^([ \t]+)oracledb:\s*([^\r\n]*)')
    if ($rule.Success -and $rule.Groups[2].Value -match '^(true|false)\s*(?:#.*)?$') { exit 0 }
    if ($rule.Success) {
        $updated = $section.Value.Remove($rule.Index, $rule.Length).Insert($rule.Index, $rule.Groups[1].Value + 'oracledb: false')
    } else {
        $indent = [regex]::Match($section.Value, '(?m)^([ \t]+)\S').Groups[1].Value
        if (-not $indent) { $indent = '  ' }
        $updated = $section.Value.TrimEnd() + "`r`n" + $indent + "oracledb: false`r`n"
    }
    $content = $content.Remove($section.Index, $section.Length).Insert($section.Index, $updated)
} else {
    $content = $content.TrimEnd() + "`r`nallowBuilds:`r`n  oracledb: false`r`n"
}
[IO.File]::WriteAllText($policyPath, $content, (New-Object Text.UTF8Encoding($false)))
