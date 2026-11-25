param([Parameter(Mandatory = $true)][string]$Path)
$ErrorActionPreference = 'Stop'
# 0.1.09：播 mp3（微软在线语音只能出 mp3，本机没 ffmpeg 就不转 wav）。
# WPF MediaPlayer 自带解码，不依赖任何外部工具；不播完就退出 ——
# 主程序那边会 kill 这个进程来「打断」，所以这里只管开播、守着时长。
Add-Type -AssemblyName PresentationCore
$m = New-Object System.Windows.Media.MediaPlayer
$m.Open([Uri]$Path)
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 100
  if ($m.NaturalDuration.HasTimeSpan) { break }
}
if (-not $m.NaturalDuration.HasTimeSpan) { throw "解不开口令：$Path" }
$ms = [int]$m.NaturalDuration.TimeSpan.TotalMilliseconds
$m.Play()
Start-Sleep -Milliseconds ($ms + 120)
$m.Stop()
$m.Close()
