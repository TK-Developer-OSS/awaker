# Copyright 2026 TK <tk.oss.developer@gmail.com>
# SPDX-License-Identifier: Apache-2.0
# Generated with Claude Code (https://claude.com/claude-code)
#
# Put an .ico into a Windows .exe (replaces its icon group), with the Win32 resource-update API — no extra tool.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/set-exe-icon.ps1 -Exe <file.exe> -Ico <file.ico>
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$Ico
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class ResEdit {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr BeginUpdateResourceW(string f, bool del);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateResourceW(IntPtr h, IntPtr type, IntPtr name, ushort lang, byte[] data, uint cb);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool EndUpdateResourceW(IntPtr h, bool discard);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr LoadLibraryExW(string f, IntPtr h, uint flags);
  [DllImport("kernel32.dll")] static extern bool FreeLibrary(IntPtr h);
  delegate bool NameProc(IntPtr m, IntPtr type, IntPtr name, IntPtr lp);
  delegate bool LangProc(IntPtr m, IntPtr type, IntPtr name, ushort lang, IntPtr lp);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool EnumResourceNamesW(IntPtr m, IntPtr type, NameProc p, IntPtr lp);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool EnumResourceLanguagesW(IntPtr m, IntPtr type, IntPtr name, LangProc p, IntPtr lp);

  static bool IsInt(IntPtr p) { return ((ulong)p.ToInt64() >> 16) == 0; }

  public static string Apply(string exe, byte[] ico) {
    // --- read the .ico directory
    int count = BitConverter.ToUInt16(ico, 4);
    var imgs = new List<byte[]>();
    var meta = new List<byte[]>(); // width,height,colors,reserved,planes(2),bits(2)
    for (int i = 0; i < count; i++) {
      int e = 6 + i * 16;
      int size = BitConverter.ToInt32(ico, e + 8);
      int off = BitConverter.ToInt32(ico, e + 12);
      var data = new byte[size];
      Array.Copy(ico, off, data, 0, size);
      imgs.Add(data);
      var m = new byte[8];
      Array.Copy(ico, e, m, 0, 4);
      Array.Copy(ico, e + 4, m, 4, 4);
      meta.Add(m);
    }
    // --- what the exe has now: icon-group names + languages, and the icon ids in use
    var groups = new List<KeyValuePair<IntPtr, ushort>>();
    int maxIconId = 0;
    IntPtr mod = LoadLibraryExW(exe, IntPtr.Zero, 0x2);
    if (mod == IntPtr.Zero) return "cannot open the exe for reading";
    var names = new List<IntPtr>();
    EnumResourceNamesW(mod, (IntPtr)14, (m, t, n, lp) => { names.Add(IsInt(n) ? n : System.Runtime.InteropServices.Marshal.StringToHGlobalUni(System.Runtime.InteropServices.Marshal.PtrToStringUni(n))); return true; }, IntPtr.Zero);
    foreach (var n in names) {
      EnumResourceLanguagesW(mod, (IntPtr)14, n, (m, t, nm, lang, lp) => { groups.Add(new KeyValuePair<IntPtr, ushort>(n, lang)); return true; }, IntPtr.Zero);
    }
    EnumResourceNamesW(mod, (IntPtr)3, (m, t, n, lp) => { if (IsInt(n)) maxIconId = Math.Max(maxIconId, (int)n.ToInt64()); return true; }, IntPtr.Zero);
    FreeLibrary(mod);
    if (groups.Count == 0) groups.Add(new KeyValuePair<IntPtr, ushort>((IntPtr)1, 1033));

    // --- the new group: header + one entry per image, pointing at fresh icon ids
    int baseId = Math.Max(maxIconId + 1, 200);
    var grp = new List<byte>();
    grp.AddRange(new byte[] { 0, 0, 1, 0 });
    grp.AddRange(BitConverter.GetBytes((ushort)count));
    for (int i = 0; i < count; i++) {
      grp.AddRange(meta[i]);                          // w,h,colors,reserved,planes,bits
      grp.AddRange(BitConverter.GetBytes(imgs[i].Length));
      grp.AddRange(BitConverter.GetBytes((ushort)(baseId + i)));
    }
    var grpBytes = grp.ToArray();

    IntPtr h = BeginUpdateResourceW(exe, false);
    if (h == IntPtr.Zero) return "BeginUpdateResource failed: " + Marshal.GetLastWin32Error();
    var langs = new HashSet<ushort>();
    foreach (var g in groups) langs.Add(g.Value);
    foreach (var lang in langs) {
      for (int i = 0; i < count; i++)
        if (!UpdateResourceW(h, (IntPtr)3, (IntPtr)(baseId + i), lang, imgs[i], (uint)imgs[i].Length)) { EndUpdateResourceW(h, true); return "UpdateResource(icon) failed: " + Marshal.GetLastWin32Error(); }
    }
    foreach (var g in groups) {
      if (!UpdateResourceW(h, (IntPtr)14, g.Key, g.Value, grpBytes, (uint)grpBytes.Length)) { EndUpdateResourceW(h, true); return "UpdateResource(group) failed: " + Marshal.GetLastWin32Error(); }
    }
    if (!EndUpdateResourceW(h, false)) return "EndUpdateResource failed: " + Marshal.GetLastWin32Error();
    return "ok: " + count + " images, " + groups.Count + " icon group(s) replaced";
  }
}
'@

$bytes = [System.IO.File]::ReadAllBytes((Resolve-Path $Ico))
$result = [ResEdit]::Apply((Resolve-Path $Exe).Path, $bytes)
Write-Output "set-exe-icon: $result"
if (-not $result.StartsWith('ok')) { exit 1 }
