# 播一个 wav，播完就把它删掉。给「听满 30 秒说一句」用。
# 用法：powershell -File playwav.ps1 "<wav 路径>"
# 说明：PlaySync 会阻塞这个 PowerShell 进程直到播完 —— 调用方是 spawn，不等它，所以不挡事。
# 不用 param 块：这个脚本存成 UTF-8 无 BOM，param( ... ) 会被 PowerShell 解析报 unexpected token。

$Path = $args[0]
if (-not $Path) { exit 1 }
if (-not (Test-Path -LiteralPath $Path)) { exit 1 }

try {
  $player = New-Object System.Media.SoundPlayer $Path
  $player.PlaySync()
} catch {
  # 声卡被独占、文件坏了都不该冒泡成错误，最多是这句没出声
} finally {
  try { Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue } catch { }
}
