# Windows 自带语音（System.Speech / SAPI）合成 wav —— 给「本机语音引擎 = Windows TTS」用。
# 存成 UTF-8 无 BOM；脚本里别用 param 块（同 playwav.ps1 的原因）。
#
# 用法：
#   powershell -File winsapi.ps1 -list "<输出 json 路径>"
#       列出系统已装语音（name / culture / gender / age），给设置页与自检看。
#   powershell -File winsapi.ps1 "<输入 txt>" "<输出 wav>" "<语音名，可空>" "<语速 -10..10>"
#       读 UTF-8 文本 → 合成 wav。语音名空 = 系统默认；语速空/0 = 正常。
#
# 注意：中文能不能念、念得好不好，取决于系统装了哪套中文语音包
# （典型是 Microsoft Huihui / Yaoyao / Kangkang，取决于 Windows 版本）。
# 没有中文包时，System.Speech 仍会出声，但会按英文读中文（很怪）。

$In = $args[0]

if ($In -eq '-list') {
  $Out = $args[1]
  if (-not $Out) { exit 2 }
  try {
    Add-Type -AssemblyName System.Speech
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $arr = @()
    foreach ($v in $s.GetInstalledVoices()) {
      if (-not $v.Enabled) { continue }
      $i = $v.VoiceInfo
      $arr += [pscustomobject]@{
        name    = $i.Name
        culture = $i.Culture.Name
        gender  = [string]$i.Gender
        age     = [string]$i.Age
      }
    }
    $s.Dispose()
    $json = ConvertTo-Json -InputObject @($arr) -Depth 3 -Compress
    [IO.File]::WriteAllText($Out, $json, (New-Object Text.UTF8Encoding $false))
    exit 0
  } catch {
    exit 3
  }
}

$Out = $args[1]
$Voice = $args[2]
$Rate = $args[3]
if (-not $In -or -not $Out) { exit 2 }
if (-not (Test-Path -LiteralPath $In)) { exit 2 }

try {
  $text = [IO.File]::ReadAllText($In, (New-Object Text.UTF8Encoding $false))
  Add-Type -AssemblyName System.Speech
  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
  if ($Voice) {
    try { $s.SelectVoice($Voice) } catch { }
  }
  if ($Rate) {
    $r = 0
    if ([int]::TryParse($Rate, [ref]$r)) {
      if ($r -lt -10) { $r = -10 }
      if ($r -gt 10) { $r = 10 }
      $s.Rate = $r
    }
  }
  $s.SetOutputToWaveFile($Out)
  $s.Speak($text)
  $s.Dispose()
  exit 0
} catch {
  exit 4
}
