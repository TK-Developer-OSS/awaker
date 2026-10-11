# Copyright 2026 TK <tk.oss.developer@gmail.com>
# SPDX-License-Identifier: Apache-2.0
# Generated with Claude Code (https://claude.com/claude-code)
#
# Replace the version information of a Windows .exe (what Explorer / Task Manager show: file description,
# product name, company, copyright…) with the Win32 resource-update API — no extra tool.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/set-exe-version.ps1 -Exe <file.exe> `
#          -ProductName <s> -Description <s> -Version <semver-ish> [-Company <s>] [-Copyright <s>] [-Comments <s>] [-OriginalName <s>]
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$ProductName,
  [Parameter(Mandatory = $true)][string]$Description,
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Company = '',
  [string]$Copyright = '',
  [string]$Comments = '',
  [string]$OriginalName = ''
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
public static class VerEdit {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr BeginUpdateResourceW(string f, bool del);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateResourceW(IntPtr h, IntPtr type, IntPtr name, ushort lang, byte[] data, uint cb);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool EndUpdateResourceW(IntPtr h, bool discard);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr LoadLibraryExW(string f, IntPtr h, uint flags);
  [DllImport("kernel32.dll")] static extern bool FreeLibrary(IntPtr h);
  delegate bool NameProc(IntPtr m, IntPtr type, IntPtr name, IntPtr lp);
  delegate bool LangProc(IntPtr m, IntPtr type, IntPtr name, ushort lang, IntPtr lp);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool EnumResourceNamesW(IntPtr m, IntPtr type, NameProc p, IntPtr lp);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool EnumResourceLanguagesW(IntPtr m, IntPtr type, IntPtr name, LangProc p, IntPtr lp);

  static void Align(MemoryStream s) { while (s.Position % 4 != 0) s.WriteByte(0); }
  static void W16(MemoryStream s, int v) { s.WriteByte((byte)(v & 0xff)); s.WriteByte((byte)((v >> 8) & 0xff)); }
  static void W32(MemoryStream s, uint v) { W16(s, (int)(v & 0xffff)); W16(s, (int)(v >> 16)); }
  static void WStr(MemoryStream s, string str) { var b = Encoding.Unicode.GetBytes(str); s.Write(b, 0, b.Length); W16(s, 0); }
  // length of a node is known only after its children are written: patch the first WORD afterwards
  static void PatchLen(MemoryStream s, long start) { long end = s.Position; s.Position = start; W16(s, (int)(end - start)); s.Position = end; }

  static void StringEntry(MemoryStream s, string key, string value) {
    long start = s.Position;
    W16(s, 0);                                   // wLength (patched)
    W16(s, value.Length + 1);                    // wValueLength: characters incl. the terminator
    W16(s, 1);                                   // text
    WStr(s, key);
    Align(s);
    WStr(s, value);
    PatchLen(s, start);
    Align(s);
  }

  public static byte[] Build(string[][] strings, ushort[] fileVer, ushort[] prodVer) {
    var s = new MemoryStream();
    long root = s.Position;
    W16(s, 0); W16(s, 52); W16(s, 0);            // length (patched), VS_FIXEDFILEINFO is 52 bytes, binary
    WStr(s, "VS_VERSION_INFO");
    Align(s);
    W32(s, 0xFEEF04BD); W32(s, 0x00010000);      // signature, struct version
    W32(s, ((uint)fileVer[0] << 16) | fileVer[1]); W32(s, ((uint)fileVer[2] << 16) | fileVer[3]);
    W32(s, ((uint)prodVer[0] << 16) | prodVer[1]); W32(s, ((uint)prodVer[2] << 16) | prodVer[3]);
    W32(s, 0x3F); W32(s, 0); W32(s, 0x00040004); W32(s, 1); W32(s, 0); W32(s, 0); W32(s, 0); // flags: VOS_NT_WINDOWS32, VFT_APP
    Align(s);
    // StringFileInfo
    long sfi = s.Position;
    W16(s, 0); W16(s, 0); W16(s, 1);
    WStr(s, "StringFileInfo");
    Align(s);
    long tab = s.Position;
    W16(s, 0); W16(s, 0); W16(s, 1);
    WStr(s, "040904b0");
    Align(s);
    foreach (var kv in strings) StringEntry(s, kv[0], kv[1]);
    PatchLen(s, tab);
    PatchLen(s, sfi);
    Align(s);
    // VarFileInfo / Translation = en-US, Unicode
    long vfi = s.Position;
    W16(s, 0); W16(s, 0); W16(s, 1);
    WStr(s, "VarFileInfo");
    Align(s);
    long v = s.Position;
    W16(s, 0); W16(s, 4); W16(s, 0);
    WStr(s, "Translation");
    Align(s);
    W16(s, 0x0409); W16(s, 0x04b0);
    PatchLen(s, v);
    PatchLen(s, vfi);
    PatchLen(s, root);
    return s.ToArray();
  }

  static bool IsInt(IntPtr p) { return ((ulong)p.ToInt64() >> 16) == 0; }

  public static string Apply(string exe, byte[] data) {
    var targets = new List<KeyValuePair<IntPtr, ushort>>();
    IntPtr mod = LoadLibraryExW(exe, IntPtr.Zero, 0x2);
    if (mod == IntPtr.Zero) return "cannot open the exe for reading";
    var names = new List<IntPtr>();
    EnumResourceNamesW(mod, (IntPtr)16, (m, t, n, lp) => { if (IsInt(n)) names.Add(n); return true; }, IntPtr.Zero);
    foreach (var n in names)
      EnumResourceLanguagesW(mod, (IntPtr)16, n, (m, t, nm, lang, lp) => { targets.Add(new KeyValuePair<IntPtr, ushort>(n, lang)); return true; }, IntPtr.Zero);
    FreeLibrary(mod);
    if (targets.Count == 0) targets.Add(new KeyValuePair<IntPtr, ushort>((IntPtr)1, 1033));
    IntPtr h = BeginUpdateResourceW(exe, false);
    if (h == IntPtr.Zero) return "BeginUpdateResource failed: " + Marshal.GetLastWin32Error();
    foreach (var t in targets)
      if (!UpdateResourceW(h, (IntPtr)16, t.Key, t.Value, data, (uint)data.Length)) { EndUpdateResourceW(h, true); return "UpdateResource failed: " + Marshal.GetLastWin32Error(); }
    if (!EndUpdateResourceW(h, false)) return "EndUpdateResource failed: " + Marshal.GetLastWin32Error();
    return "ok: " + targets.Count + " version resource(s) replaced";
  }
}
'@

# "0.1.0-dev.1" -> numbers 0.1.0.1 for the fixed part; the text keeps the full string
$nums = @([regex]::Matches($Version, '\d+') | ForEach-Object { [int]$_.Value })
while ($nums.Count -lt 4) { $nums += 0 }
$fv = [uint16[]]@($nums[0], $nums[1], $nums[2], $nums[3])
$fileVersionText = ($fv -join '.')
$pairs = New-Object System.Collections.Generic.List[string[]]
function Add-Pair([string]$k, [string]$v) { if ($v -ne '') { $pairs.Add([string[]]@($k, $v)) } }
Add-Pair 'CompanyName' $Company
Add-Pair 'FileDescription' $Description
Add-Pair 'FileVersion' $fileVersionText
Add-Pair 'InternalName' (([IO.Path]::GetFileNameWithoutExtension($Exe)))
Add-Pair 'LegalCopyright' $Copyright
Add-Pair 'OriginalFilename' $(if ($OriginalName) { $OriginalName } else { [IO.Path]::GetFileName($Exe) })
Add-Pair 'ProductName' $ProductName
Add-Pair 'ProductVersion' $Version
Add-Pair 'Comments' $Comments

$bytes = [VerEdit]::Build($pairs.ToArray(), $fv, $fv)
$result = [VerEdit]::Apply((Resolve-Path $Exe).Path, $bytes)
Write-Output "set-exe-version: $result"
if (-not $result.StartsWith('ok')) { exit 1 }
