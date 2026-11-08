<#
.SYNOPSIS
Stamps a shortcut with the dev AppUserModelID, so a dev run's window shares that shortcut's taskbar button.

.DESCRIPTION
Windows puts a window on a pinned taskbar button only when the two carry the same AppUserModelID. A dev run sets
turnstone-desktop.dev (src/main/app-identity.js), and a shortcut made by hand carries none, so without this a dev copy
the pin did not start gets a button of its own. Installed builds need nothing: Squirrel stamps its own shortcuts.

If the taskbar still shows two buttons afterwards, unpin the shortcut and pin it again: Explorer can keep the identity
it read when the shortcut was first pinned.

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\stamp-dev-shortcut.ps1 -Path "$env:APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\Turnstone Desktop (dev).lnk"
#>
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$AppId = "turnstone-desktop.dev"
)
$ErrorActionPreference = "Stop"

$full = (Resolve-Path -LiteralPath $Path).Path
if ([IO.Path]::GetExtension($full) -ne ".lnk") { throw "not a shortcut: $full" }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class ShortcutAppId {
  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  struct PROPERTYKEY { public Guid fmtid; public uint pid; }

  // PROPVARIANT is 16 bytes on 32-bit Windows and 24 on 64-bit; only the type and the string pointer are used.
  [StructLayout(LayoutKind.Explicit)]
  struct PROPVARIANT {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr p;
    [FieldOffset(16)] public long pad;
  }

  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int GetAt(uint index, out PROPERTYKEY key);
    [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
    [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
    [PreserveSig] int Commit();
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHGetPropertyStoreFromParsingName(
    string path, IntPtr bindContext, int flags, ref Guid iid,
    [MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);

  [DllImport("ole32.dll")]
  static extern int PropVariantClear(ref PROPVARIANT value);

  const ushort VT_LPWSTR = 31;
  const int GPS_DEFAULT = 0;
  const int GPS_READWRITE = 2;

  // PKEY_AppUserModel_ID
  static PROPERTYKEY AppIdKey() {
    return new PROPERTYKEY { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
  }

  static IPropertyStore Open(string path, int flags) {
    Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
    IPropertyStore store;
    int hr = SHGetPropertyStoreFromParsingName(path, IntPtr.Zero, flags, ref iid, out store);
    if (hr != 0) Marshal.ThrowExceptionForHR(hr);
    return store;
  }

  public static void Set(string path, string appId) {
    IPropertyStore store = Open(path, GPS_READWRITE);
    PROPERTYKEY key = AppIdKey();
    PROPVARIANT value = new PROPVARIANT();
    value.vt = VT_LPWSTR;
    value.p = Marshal.StringToCoTaskMemUni(appId);
    try {
      int hr = store.SetValue(ref key, ref value);
      if (hr != 0) Marshal.ThrowExceptionForHR(hr);
      hr = store.Commit();
      if (hr != 0) Marshal.ThrowExceptionForHR(hr);
    } finally {
      PropVariantClear(ref value);
      Marshal.ReleaseComObject(store);
    }
  }

  public static string Get(string path) {
    IPropertyStore store = Open(path, GPS_DEFAULT);
    try {
      PROPERTYKEY key = AppIdKey();
      PROPVARIANT value;
      int hr = store.GetValue(ref key, out value);
      if (hr != 0) Marshal.ThrowExceptionForHR(hr);
      string result = value.vt == VT_LPWSTR ? Marshal.PtrToStringUni(value.p) : null;
      PropVariantClear(ref value);
      return result;
    } finally {
      Marshal.ReleaseComObject(store);
    }
  }
}
'@

[ShortcutAppId]::Set($full, $AppId)
$readBack = [ShortcutAppId]::Get($full)
if ($readBack -ne $AppId) { throw "the shortcut reads back '$readBack', not '$AppId'" }
"{0}: AppUserModelID is now {1}" -f $full, $readBack
