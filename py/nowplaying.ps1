# 读「现在在放什么」：SMTC 状态 + 窗口标题兜底，单次执行输出一行 JSON。
#
# 为什么两路都要：
#   · SMTC 能给「在放 / 暂停」，但网易云常常不注册会话，或者只报 pos=0/dur=0；
#   · 窗口标题能稳定给「歌名 - 歌手」，但分不清暂停。
#   所以要的是：SMTC 管状态，标题管曲目。
#
# 为什么不能只看 MainWindowTitle：
#   开着桌面歌词时，网易云的「主窗口」会变成 DesktopLyrics|桌面歌词，
#   于是会读出一首叫《桌面歌词》的幽灵曲目。歌名其实在另一个窗口上
#   （class=OrpheusBrowserHost），它偏偏不是主窗口，只能自己枚举。
param(
  [int]$TimeoutMs = 0
)

$ErrorActionPreference = 'Stop'

# 管道另一头是 Node，读的是 UTF-8。不设这个，中文歌名会变成问号。
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

$res = [ordered]@{
  ok      = $true
  playing = $false
  app     = ''
  title   = ''
  artist  = ''
  source  = 'none'
}

# ── 一、SMTC：只要「有没有在放」和播放器名字 ──────────────────────────
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]

  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $task = $asTaskGeneric.MakeGenericMethod(
    [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]).Invoke(
      $null, @([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()))
  $task.Wait(-1) | Out-Null
  $mgr = $task.Result

  foreach ($s in $mgr.GetSessions()) {
    try {
      $info = $s.GetPlaybackInfo()
      $status = $info.PlaybackStatus.ToString()
    } catch { continue }
    $appId = ''
    try { $appId = $s.SourceAppUserModelId } catch { }
    if ($status -eq 'Playing') {
      $res.playing = $true
      if ($appId) { $res.app = $appId }
      break
    }
  }
} catch {
  # WinRT 不可用不算失败：标题兜底还能给歌名。
}

# ── 二、窗口标题：给「歌名 - 歌手」 ───────────────────────────────────
if (-not ('CnbgWinTitle' -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class CnbgWinTitle {
  delegate bool Proc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(Proc f, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static string[] Pairs(int[] pids) {
    var res = new List<string>();
    var set = new HashSet<uint>();
    foreach (int p in pids) { set.Add((uint)p); }
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (set.Contains(p)) {
        var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
        if (sb.Length > 0) {
          var cn = new StringBuilder(256); GetClassName(h, cn, 256);
          res.Add(cn.ToString() + (char)9 + sb.ToString());
        }
      }
      return true;
    }, IntPtr.Zero);
    return res.ToArray();
  }
}
"@
}

function Get-SongWindowTitle {
  $procs = @(Get-Process cloudmusic -ErrorAction SilentlyContinue)
  if ($procs.Count -eq 0) { return '' }
  $pairs = [CnbgWinTitle]::Pairs([int[]]($procs | ForEach-Object { $_.Id }))

  $best = ''
  $bestScore = 0
  foreach ($pair in $pairs) {
    $tab = $pair.IndexOf([char]9)
    if ($tab -lt 0) { continue }
    $cls = $pair.Substring(0, $tab)
    $text = $pair.Substring($tab + 1)
    switch ($cls) {
      'IME' { continue }
      'MSCTFIME UI' { continue }
      'SoPY_Hint' { continue }
      'Sogou_TSF_UI' { continue }
      'GDI+ Hook Window Class' { continue }
    }
    if ($text -match '^(桌面歌词|迷你播放器|网易云音乐|CloudMusic|NetEase Cloud Music|HintWnd|Default IME)') { continue }

    $score = 0
    if ($cls -eq 'OrpheusBrowserHost') { $score += 100 }
    if ($text -match '\s+[-\u2013\u2014]\s+') { $score += 10 }
    if ($score -gt $bestScore) { $bestScore = $score; $best = $text }
  }
  return $best
}

try {
  $raw = (Get-SongWindowTitle -replace '\s+', ' ').Trim()
  if ($raw -and $raw -notmatch '^(网易云音乐|CloudMusic|NetEase Cloud Music)$') {
    # 歌名和歌手之间是「 - 」，破折号全角半角都有，两边留空格才算分隔符。
    # 只切一刀：歌名里带「 - 」的情况比歌手名里多。
    $parts = $raw -split '\s+[-\u2013\u2014]\s+', 2
    $res.title = $parts[0].Trim()
    if ($parts.Count -gt 1) { $res.artist = $parts[1].Trim() }
    $res.source = 'title'
    if (-not $res.app) { $res.app = 'cloudmusic.exe' }
  }
} catch {
  $res.ok = $false
}

# ── 三、两路都没有 → 没在放 ──────────────────────────────────────────
if (-not $res.title) {
  # 标题读不到时，SMTC 里可能还有曲目（QQ 音乐那条路就靠这个）。
  try {
    $mgr2 = $mgr
    if ($mgr2) {
      foreach ($s in $mgr2.GetSessions()) {
        try {
          if ($s.GetPlaybackInfo().PlaybackStatus.ToString() -ne 'Playing') { continue }
          $props = $s.TryGetMediaPropertiesAsync()
          $t2 = $asTaskGeneric.MakeGenericMethod(
            [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]).Invoke($null, @($props))
          $t2.Wait(-1) | Out-Null
          $mp = $t2.Result
          if ($mp.Title) {
            $res.title = $mp.Title
            $res.artist = $mp.Artist
            $res.source = 'smtc'
            if (-not $res.app) { $res.app = $s.SourceAppUserModelId }
          }
          break
        } catch { continue }
      }
    }
  } catch { }
}

[Console]::Out.WriteLine(($res | ConvertTo-Json -Compress))
[Console]::Out.Flush()
