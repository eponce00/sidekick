import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { createInterface } from 'readline'
import { parseComputerApps, powershellPath, type ComputerApp } from './computerUseApps'
import type { ComputerExpandState, ComputerWindowBounds } from './computerUseDriver'

// Starting it compiles its code, which takes a second or two, and a model's turn can outlast a minute.
const HELPER_IDLE_MS = 3 * 60_000
const REQUEST_TIMEOUT_MS = 10_000

// Windows messages to an app's own page window, which web-based apps accept without focus and the
// driver doesn't send. Chromium takes keys on its page window but ignores a wheel there while covered.
// WebView2 apps drawn through a composition host are the other way round: wheel, but no keys.
const HELPER_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase, System.Drawing
Add-Type -ReferencedAssemblies System.Drawing, UIAutomationClient, UIAutomationTypes, WindowsBase -TypeDefinition @'
using System; using System.IO; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Windows.Automation;
public static class SideKickWindows {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; public Point(int x, int y) { X = x; Y = y; } }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out Rect r);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint c);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int t, uint f);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out Point p);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int n);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out Rect v, int n);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint a, bool i, uint p);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, uint f, StringBuilder s, ref uint n);
  [StructLayout(LayoutKind.Sequential)] struct MouseInput { public int X, Y, Data; public uint Flags, Time; public IntPtr Extra; }
  [StructLayout(LayoutKind.Sequential)] struct KeyInput { public ushort Vk, Scan; public uint Flags, Time; public IntPtr Extra; }
  [StructLayout(LayoutKind.Explicit)] struct Input { [FieldOffset(0)] public int Type; [FieldOffset(8)] public MouseInput Mouse; [FieldOffset(8)] public KeyInput Key; }
  [DllImport("user32.dll")] static extern uint SendInput(uint n, Input[] i, int size);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint c, uint t);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] static extern bool OpenClipboard(IntPtr h);
  [DllImport("user32.dll")] static extern bool CloseClipboard();
  [DllImport("user32.dll")] static extern bool EmptyClipboard();
  [DllImport("user32.dll")] static extern IntPtr GetClipboardData(uint f);
  [DllImport("user32.dll")] static extern IntPtr SetClipboardData(uint f, IntPtr h);
  [DllImport("user32.dll")] static extern uint EnumClipboardFormats(uint f);
  [DllImport("user32.dll")] static extern bool IsClipboardFormatAvailable(uint f);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern uint RegisterClipboardFormat(string name);
  [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
  [DllImport("user32.dll")] static extern IntPtr GetClipboardOwner();
  [DllImport("kernel32.dll")] static extern IntPtr GlobalAlloc(uint f, UIntPtr n);
  [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr h);
  [DllImport("kernel32.dll")] static extern UIntPtr GlobalSize(IntPtr h);
  delegate bool MonitorProc(IntPtr m, IntPtr dc, IntPtr r, IntPtr d);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorProc f, IntPtr d);
  [StructLayout(LayoutKind.Sequential)] struct MonitorInfo { public int Size; public Rect Monitor, Work; public int Flags; }
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MonitorInfo i);
  [DllImport("user32.dll")] static extern bool GetWindowDisplayAffinity(IntPtr h, out uint a);
  const uint WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101, WM_CHAR = 0x0102, WM_MOUSEWHEEL = 0x020A;
  const int VK_PRIOR = 0x21, VK_NEXT = 0x22;
  static string ClassOf(IntPtr h) {
    StringBuilder s = new StringBuilder(128);
    GetClassName(h, s, 128);
    return s.ToString();
  }
  // The largest one: a browser keeps a page window for each of its other tabs too, so those must
  // also show. WhatsApp's input window counts as hidden and still takes the wheel.
  static IntPtr Child(IntPtr top, string name) {
    IntPtr found = IntPtr.Zero;
    long largest = -1;
    EnumChildWindows(top, delegate(IntPtr c, IntPtr l) {
      Rect r;
      if (ClassOf(c) == name && (IsWindowVisible(c) || name != "Chrome_RenderWidgetHostHWND") && GetWindowRect(c, out r)) {
        long area = (long)(r.R - r.L) * (r.B - r.T);
        if (area > largest) { largest = area; found = c; }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  // Some Electron apps have no separate page window, and take keys on their main one.
  static IntPtr ChromiumPage(long window) {
    IntPtr top = new IntPtr(window);
    IntPtr page = Child(top, "Chrome_RenderWidgetHostHWND");
    if (page != IntPtr.Zero) return page;
    return ClassOf(top).StartsWith("Chrome_WidgetWin") ? top : IntPtr.Zero;
  }
  static void Key(IntPtr page, int vk) {
    PostMessage(page, WM_KEYDOWN, new IntPtr(vk), new IntPtr(1));
    PostMessage(page, WM_KEYUP, new IntPtr(vk), new IntPtr(unchecked((int)0xC0000001)));
  }
  public static bool SendText(long window, string text) {
    IntPtr page = ChromiumPage(window);
    if (page == IntPtr.Zero) return false;
    foreach (char c in text.Replace("\\r\\n", "\\r").Replace('\\n', '\\r')) PostMessage(page, WM_CHAR, new IntPtr(c), new IntPtr(1));
    return true;
  }
  public static bool SendKey(long window, int vk) {
    IntPtr page = ChromiumPage(window);
    if (page == IntPtr.Zero) return false;
    Key(page, vk);
    return true;
  }
  public static bool SendWheel(long window, bool down, int ticks, int x, int y) {
    IntPtr site = Child(new IntPtr(window), "InputSiteWindowClass");
    if (site != IntPtr.Zero) {
      IntPtr wheel = new IntPtr((down ? -120 : 120) << 16);
      IntPtr point = new IntPtr((y << 16) | (x & 0xffff));
      for (int i = 0; i < ticks; i++) PostMessage(site, WM_MOUSEWHEEL, wheel, point);
      return true;
    }
    // Keys scroll a page with its own window. Docker Desktop's main window took them and didn't move.
    IntPtr page = Child(new IntPtr(window), "Chrome_RenderWidgetHostHWND");
    if (page == IntPtr.Zero) return false;
    for (int i = 0; i < Math.Max(1, (ticks + 2) / 3); i++) Key(page, down ? VK_NEXT : VK_PRIOR);
    return true;
  }
  // Measured on Docker Desktop: with no separate page window, a click posted to it never lands, and
  // can still pull the app forward.
  public static bool IgnoresPostedClicks(long window) {
    IntPtr top = new IntPtr(window);
    return ClassOf(top).StartsWith("Chrome_WidgetWin")
      && Child(top, "Chrome_RenderWidgetHostHWND") == IntPtr.Zero
      && Child(top, "InputSiteWindowClass") == IntPtr.Zero;
  }
  // A Store app's window belongs to a shared host, and the app itself draws in a window inside it.
  static IntPtr StoreAppWindow(IntPtr frame) {
    return ClassOf(frame) == "ApplicationFrameWindow" ? Child(frame, "Windows.UI.Core.CoreWindow") : IntPtr.Zero;
  }
  static uint OwnerOf(IntPtr h) {
    uint pid;
    GetWindowThreadProcessId(h, out pid);
    return pid;
  }
  public static string PathOf(uint pid) {
    IntPtr process = OpenProcess(0x1000, false, pid);
    if (process == IntPtr.Zero) return null;
    StringBuilder path = new StringBuilder(1024);
    uint size = 1024;
    bool found = QueryFullProcessImageName(process, 0, path, ref size);
    CloseHandle(process);
    return found ? path.ToString() : null;
  }
  // Each process with a visible window nothing owns, as "pid|path", joined by a mark no path can hold.
  public static string Apps() {
    System.Collections.Generic.Dictionary<uint, string> paths = new System.Collections.Generic.Dictionary<uint, string>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero) return true;
      IntPtr storeApp = StoreAppWindow(h);
      uint pid = OwnerOf(storeApp != IntPtr.Zero ? storeApp : h);
      if (!paths.ContainsKey(pid)) {
        string path = PathOf(pid);
        if (path != null) paths[pid] = path;
      }
      return true;
    }, IntPtr.Zero);
    StringBuilder all = new StringBuilder();
    foreach (System.Collections.Generic.KeyValuePair<uint, string> app in paths) all.Append(app.Key).Append('|').Append(app.Value).Append('?');
    return all.ToString();
  }
  // Windows a person could see: not hidden, minimized, on another desktop, or without a title.
  public static string WindowsOf(uint pid) {
    StringBuilder all = new StringBuilder();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      Rect r;
      int cloaked;
      IntPtr storeApp = StoreAppWindow(h);
      if (OwnerOf(storeApp != IntPtr.Zero ? storeApp : h) != pid || !IsWindowVisible(h) || IsIconic(h) || !GetWindowRect(h, out r)) return true;
      if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      // What shows: a window's own rectangle has invisible borders, which pictures of it leave out.
      Rect frame;
      if (DwmGetWindowAttribute(h, 9, out frame, 16) == 0) r = frame;
      StringBuilder title = new StringBuilder(512);
      GetWindowText(h, title, 512);
      string text = title.ToString().Replace('\\r', ' ').Replace('\\n', ' ').Replace('\\u0001', ' ');
      if (text == "" || text == "Program Manager" || IsPopup(h, true)) return true;
      all.Append(h.ToInt64()).Append(',').Append(OwnerOf(h)).Append(',').Append(r.L).Append(',').Append(r.T).Append(',').Append(r.R - r.L).Append(',').Append(r.B - r.T).Append(',').Append(text).Append('\\u0001');
      return true;
    }, IntPtr.Zero);
    return all.ToString();
  }
  // A menu or dropdown rather than a dialog. WinUI's are titled PopupHost, so a title doesn't settle it,
  // and a dialog is the one with a title bar. A window with neither is the app's own business.
  static bool IsPopup(IntPtr h, bool titled) {
    if ((GetWindowLong(h, -16) & 0x00C00000) == 0x00C00000) return false;
    string name = ClassOf(h);
    if (name == "#32768" || name.Contains("Popup")) return true;
    return !titled && GetWindow(h, 4) != IntPtr.Zero;
  }
  // A picture of the app leaves these out. Each is drawn here, wherever it is and whatever covers it,
  // as "x,y,width,height,png", bottom-most first.
  public static string Popups(long window) {
    IntPtr main = new IntPtr(window);
    uint pid = OwnerOf(main);
    IntPtr mainStoreApp = StoreAppWindow(main);
    uint appPid = mainStoreApp != IntPtr.Zero ? OwnerOf(mainStoreApp) : pid;
    Rect m;
    if (!GetWindowRect(main, out m)) return "";
    long mainArea = (long)(m.R - m.L) * (m.B - m.T);
    List<string> found = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (h == main || found.Count >= 6 || !IsWindowVisible(h) || IsIconic(h)) return true;
      if (OwnerOf(h) != pid && OwnerOf(h) != appPid) return true;
      StringBuilder title = new StringBuilder(2);
      GetWindowText(h, title, 2);
      int cloaked;
      if (!IsPopup(h, title.Length > 0) || (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0)) return true;
      Rect r;
      if (!GetWindowRect(h, out r)) return true;
      int w = r.R - r.L, t = r.B - r.T;
      // Anything nearly as big as the app is more likely a clear overlay, which would hide it.
      if (w <= 0 || t <= 0 || (long)w * t * 10 > mainArea * 8) return true;
      if (r.R <= m.L || r.L >= m.R || r.B <= m.T || r.T >= m.B) return true;
      using (System.Drawing.Bitmap picture = new System.Drawing.Bitmap(w, t))
      using (System.Drawing.Graphics g = System.Drawing.Graphics.FromImage(picture))
      using (MemoryStream png = new MemoryStream()) {
        IntPtr dc = g.GetHdc();
        bool drawn = PrintWindow(h, dc, 2);
        g.ReleaseHdc(dc);
        if (drawn) {
          picture.Save(png, System.Drawing.Imaging.ImageFormat.Png);
          found.Insert(0, r.L + "," + r.T + "," + w + "," + t + "," + Convert.ToBase64String(png.ToArray()));
        }
      }
      return true;
    }, IntPtr.Zero);
    return string.Join(";", found);
  }
  // Dialogs a window owns, in the same form as WindowsOf. Chrome shows its folder picker from another of
  // its processes, which owns no window of its own, so going by process doesn't find it.
  public static string OwnedBy(long window) {
    IntPtr main = new IntPtr(window);
    StringBuilder all = new StringBuilder();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      Rect r;
      if (GetWindow(h, 4) != main || !IsWindowVisible(h) || !GetWindowRect(h, out r)) return true;
      StringBuilder title = new StringBuilder(512);
      GetWindowText(h, title, 512);
      string text = title.ToString().Replace('\\r', ' ').Replace('\\n', ' ').Replace('\\u0001', ' ');
      if (text == "" || IsPopup(h, true)) return true;
      all.Append(h.ToInt64()).Append(',').Append(OwnerOf(h)).Append(',').Append(r.L).Append(',').Append(r.T).Append(',').Append(r.R - r.L).Append(',').Append(r.B - r.T).Append(',').Append(text).Append('\\u0001');
      return true;
    }, IntPtr.Zero);
    return all.ToString();
  }
  public static bool CloseWindow(long window) { return PostMessage(new IntPtr(window), 0x0010, IntPtr.Zero, IntPtr.Zero); }
  // A minimized app can't be read or clicked. This brings its largest window back behind everything
  // else, without focus, so nothing changes for whoever is using the computer. 0 if it has none.
  public static long RestoreBehind(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      IntPtr storeApp = StoreAppWindow(h);
      if (OwnerOf(storeApp != IntPtr.Zero ? storeApp : h) == pid && found == IntPtr.Zero && IsWindowVisible(h) && IsIconic(h)) {
        StringBuilder title = new StringBuilder(2);
        GetWindowText(h, title, 2);
        if (title.Length > 0) found = h;
      }
      return true;
    }, IntPtr.Zero);
    if (found == IntPtr.Zero) return 0;
    IntPtr bottom = new IntPtr(1);
    // No move, no resize, no activate.
    SetWindowPos(found, bottom, 0, 0, 0, 0, 0x13);
    ShowWindow(found, 4);
    SetWindowPos(found, bottom, 0, 0, 0, 0, 0x13);
    return found.ToInt64();
  }
  public static bool MinimizeAgain(long window) { return ShowWindow(new IntPtr(window), 7); }
  public static string Pointer() {
    Point at;
    return GetCursorPos(out at) ? at.X + "," + at.Y : "";
  }
  public static bool PointerTo(int x, int y) { return SetCursorPos(x, y); }
  // What is still held when this helper ends gets let go, or the user would be left with it stuck.
  static readonly HashSet<int> HeldKeys = new HashSet<int>();
  static string HeldButton = null;
  static uint ButtonFlag(string button, bool down) {
    // These flags mean the physical button, so a swapped mouse would get the other one.
    bool swapped = GetSystemMetrics(23) != 0;
    string real = button == "middle" ? button : (button == "right") != swapped ? "right" : "left";
    uint press = real == "right" ? 0x8u : real == "middle" ? 0x20u : 0x2u;
    return down ? press : press * 2;
  }
  public static bool MouseButton(string button, bool down) {
    Input[] input = new Input[1];
    input[0].Type = 0;
    input[0].Mouse.Flags = ButtonFlag(button, down);
    bool sent = SendInput(1, input, Marshal.SizeOf(typeof(Input))) == 1;
    if (sent) HeldButton = down ? button : null;
    return sent;
  }
  public static bool KeyState(int vk, bool down) {
    // The arrows and the block above them are "extended" keys, which an app can tell from the keypad.
    bool extended = vk >= 0x21 && vk <= 0x2E;
    Input[] input = new Input[1];
    input[0].Type = 1;
    input[0].Key.Vk = (ushort)vk;
    input[0].Key.Scan = (ushort)MapVirtualKey((uint)vk, 0);
    input[0].Key.Flags = (extended ? 1u : 0u) | (down ? 0u : 2u);
    bool sent = SendInput(1, input, Marshal.SizeOf(typeof(Input))) == 1;
    if (sent && down) HeldKeys.Add(vk);
    if (sent && !down) HeldKeys.Remove(vk);
    return sent;
  }
  public static void LetGoOfEverything() {
    if (HeldButton != null) MouseButton(HeldButton, false);
    foreach (int vk in new List<int>(HeldKeys)) KeyState(vk, false);
  }
  static readonly string[] NotForHistory = { "ExcludeClipboardContentFromMonitorProcessing", "CanIncludeInClipboardHistory", "CanUploadToCloudClipboard" };
  static Dictionary<uint, byte[]> SavedClipboard = null;
  const long MaxSavedClipboard = 64L * 1024 * 1024;
  static bool OpenBoard() {
    for (int i = 0; i < 20; i++) {
      if (OpenClipboard(IntPtr.Zero)) return true;
      System.Threading.Thread.Sleep(25);
    }
    return false;
  }
  static IntPtr Global(byte[] data) {
    IntPtr h = GlobalAlloc(2, new UIntPtr((ulong)Math.Max(data.Length, 1)));
    IntPtr to = GlobalLock(h);
    Marshal.Copy(data, 0, to, data.Length);
    GlobalUnlock(h);
    return h;
  }
  // Marked this way, it stays out of the clipboard history and of other devices. The history already
  // has whatever the user copied themselves, and a password put back must not arrive there as new.
  static void MarkNotForHistory() {
    foreach (string name in NotForHistory) SetClipboardData(RegisterClipboardFormat(name), Global(new byte[4]));
  }
  // What a password manager marks: its copies are meant for one paste, and not for anything watching.
  static bool MarkedPrivate() {
    if (IsClipboardFormatAvailable(RegisterClipboardFormat("ExcludeClipboardContentFromMonitorProcessing"))) return true;
    if (IsClipboardFormatAvailable(RegisterClipboardFormat("Clipboard Viewer Ignore"))) return true;
    uint history = RegisterClipboardFormat("CanIncludeInClipboardHistory");
    if (!IsClipboardFormatAvailable(history) || !OpenBoard()) return false;
    try {
      IntPtr from = GlobalLock(GetClipboardData(history));
      if (from == IntPtr.Zero) return false;
      int allowed = Marshal.ReadInt32(from);
      GlobalUnlock(GetClipboardData(history));
      return allowed == 0;
    } finally { CloseClipboard(); }
  }
  // As "sequence,owner,has text,private".
  public static string ClipboardInfo() {
    return GetClipboardSequenceNumber() + "," + OwnerOf(GetClipboardOwner()) + "," + (IsClipboardFormatAvailable(13) ? 1 : 0) + "," + (MarkedPrivate() ? 1 : 0);
  }
  // As "sequence,text in base64", checked as it is read, since what it holds can change at any time.
  public static string ClipboardText(bool evenPrivate) {
    if (!evenPrivate && MarkedPrivate()) return "";
    if (!OpenBoard()) return "";
    try {
      IntPtr h = GetClipboardData(13);
      if (h == IntPtr.Zero) return "";
      string text = Marshal.PtrToStringUni(GlobalLock(h));
      GlobalUnlock(h);
      return GetClipboardSequenceNumber() + "," + Convert.ToBase64String(Encoding.UTF8.GetBytes(text ?? ""));
    } finally { CloseClipboard(); }
  }
  // The clipboard's new sequence number, or 0.
  public static long ClipboardWrite(string base64, bool notForHistory) {
    if (!OpenBoard()) return 0;
    try {
      if (!EmptyClipboard()) return 0;
      byte[] text = Encoding.Unicode.GetBytes(Encoding.UTF8.GetString(Convert.FromBase64String(base64)) + "\\0");
      SetClipboardData(13, Global(text));
      if (notForHistory) MarkNotForHistory();
    } finally { CloseClipboard(); }
    return GetClipboardSequenceNumber();
  }
  // Keeps what is there, in this helper only. Formats that aren't plain memory are left out: Windows
  // makes those again from the ones that are, as it does a bitmap from its DIB.
  public static bool ClipboardSave() {
    if (!OpenBoard()) return false;
    try {
      Dictionary<uint, byte[]> saved = new Dictionary<uint, byte[]>();
      long total = 0;
      uint format = 0;
      while ((format = EnumClipboardFormats(format)) != 0) {
        bool handle = format == 2 || format == 3 || format == 9 || format == 14 || format == 0x80 || format == 0x82 || format == 0x83 || format == 0x8E;
        if (handle || (format >= 0x200 && format <= 0x3FF)) continue;
        IntPtr h = GetClipboardData(format);
        if (h == IntPtr.Zero) continue;
        IntPtr from = GlobalLock(h);
        if (from == IntPtr.Zero) continue;
        long size = (long)GlobalSize(h).ToUInt64();
        total += size;
        if (total > MaxSavedClipboard) { GlobalUnlock(h); return false; }
        byte[] data = new byte[size];
        Marshal.Copy(from, data, 0, data.Length);
        GlobalUnlock(h);
        saved[format] = data;
      }
      SavedClipboard = saved;
      return true;
    } finally { CloseClipboard(); }
  }
  // Only if the clipboard is as the agent left it. If not, the user has copied something since.
  public static bool ClipboardRestore(long sequence) {
    Dictionary<uint, byte[]> saved = SavedClipboard;
    SavedClipboard = null;
    if (saved == null || GetClipboardSequenceNumber() != sequence || !OpenBoard()) return false;
    try {
      if (!EmptyClipboard()) return false;
      foreach (KeyValuePair<uint, byte[]> item in saved) SetClipboardData(item.Key, Global(item.Value));
      MarkNotForHistory();
      return true;
    } finally { CloseClipboard(); }
  }
  public static void ClipboardForget() { SavedClipboard = null; }
  static List<Rect> Monitors() {
    List<Rect> primary = new List<Rect>(), others = new List<Rect>();
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr m, IntPtr dc, IntPtr r, IntPtr d) {
      MonitorInfo info = new MonitorInfo();
      info.Size = Marshal.SizeOf(typeof(MonitorInfo));
      if (GetMonitorInfo(m, ref info)) ((info.Flags & 1) != 0 ? primary : others).Add(info.Monitor);
      return true;
    }, IntPtr.Zero);
    primary.AddRange(others);
    return primary;
  }
  // Front first. A window that can't say what it is counts as one to hide.
  static void ScreenWindows(Rect area, HashSet<string> hidden, List<Rect> blank, List<string> rows) {
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      Rect r;
      int cloaked;
      uint affinity;
      if (!IsWindowVisible(h) || IsIconic(h) || !GetWindowRect(h, out r)) return true;
      if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      // Already left out of any capture. SideKick's glow is one, and blanking it would hide the app under it.
      if (GetWindowDisplayAffinity(h, out affinity) && affinity != 0) return true;
      if (r.R <= area.L || r.L >= area.R || r.B <= area.T || r.T >= area.B) return true;
      IntPtr storeApp = StoreAppWindow(h);
      string path = PathOf(OwnerOf(storeApp != IntPtr.Zero ? storeApp : h));
      bool hide = path == null || hidden.Contains(Path.GetFileNameWithoutExtension(path).ToLowerInvariant());
      if (hide) blank.Add(r);
      StringBuilder title = new StringBuilder(32);
      GetWindowText(h, title, 32);
      if (title.Length > 0 && title.ToString() != "Program Manager" && GetWindow(h, 4) == IntPtr.Zero && !IsPopup(h, true))
        rows.Add((path ?? "") + "|" + r.L + "|" + r.T + "|" + r.R + "|" + r.B + "|" + (hide ? 1 : 0));
      return true;
    }, IntPtr.Zero);
  }
  // As "index,count,x,y,width,height,picture width,picture height;apps in base64;png in base64". The
  // windows are listed before and after the copy, so one opening meanwhile is blanked as well, and every
  // pixel of what is hidden is gone before anything leaves this helper. Covered parts are blanked too:
  // a clear overlay above a window would otherwise count as covering it.
  public static string Screen(int display, int maxWidth, string hiddenNames) {
    List<Rect> monitors = Monitors();
    if (display < 0 || display >= monitors.Count) return "";
    Rect area = monitors[display];
    HashSet<string> hidden = new HashSet<string>(hiddenNames.Split(','));
    List<Rect> blank = new List<Rect>();
    List<string> rows = new List<string>();
    ScreenWindows(area, hidden, blank, rows);
    int w = area.R - area.L, t = area.B - area.T;
    using (System.Drawing.Bitmap full = new System.Drawing.Bitmap(w, t))
    using (System.Drawing.Graphics g = System.Drawing.Graphics.FromImage(full)) {
      g.CopyFromScreen(area.L, area.T, 0, 0, new System.Drawing.Size(w, t));
      ScreenWindows(area, hidden, blank, new List<string>());
      using (System.Drawing.SolidBrush fill = new System.Drawing.SolidBrush(System.Drawing.Color.FromArgb(58, 58, 66)))
      using (System.Drawing.SolidBrush ink = new System.Drawing.SolidBrush(System.Drawing.Color.White))
      using (System.Drawing.Font font = new System.Drawing.Font("Segoe UI", Math.Max(14, w / 70), System.Drawing.GraphicsUnit.Pixel)) {
        foreach (Rect r in blank) {
          g.FillRectangle(fill, r.L - area.L, r.T - area.T, r.R - r.L, r.B - r.T);
          g.DrawString("Hidden by SideKick", font, ink, Math.Max(r.L - area.L, 0) + 16, Math.Max(r.T - area.T, 0) + 16);
        }
      }
      int width = Math.Min(w, maxWidth), height = (int)Math.Round((double)t * width / w);
      using (System.Drawing.Bitmap small = new System.Drawing.Bitmap(width, height))
      using (System.Drawing.Graphics shrink = System.Drawing.Graphics.FromImage(small))
      using (MemoryStream png = new MemoryStream()) {
        shrink.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
        shrink.DrawImage(full, 0, 0, width, height);
        small.Save(png, System.Drawing.Imaging.ImageFormat.Png);
        return display + "," + monitors.Count + "," + area.L + "," + area.T + "," + w + "," + t + "," + width + "," + height + ";"
          + Convert.ToBase64String(Encoding.UTF8.GetBytes(string.Join("?", rows))) + ";" + Convert.ToBase64String(png.ToArray());
      }
    }
  }
  // Whether a window is drawn by a web engine, itself or in a window inside it.
  public static bool IsWebBased(long window) {
    IntPtr top = new IntPtr(window);
    if (ClassOf(top).StartsWith("Chrome_")) return true;
    bool found = false;
    EnumChildWindows(top, delegate(IntPtr c, IntPtr l) {
      found = ClassOf(c).StartsWith("Chrome_");
      return !found;
    }, IntPtr.Zero);
    return found;
  }
  // Presses a control by what it is, which needs no focus and works whatever covers the app. The first
  // of its actions it takes. Two alike in the same place are one thing to a person, so either will do.
  // Past the wait it counts as sent once it has begun: an app can sit on a press, and it may still land.
  public static bool PressControl(long window, string name, int x, int y, int w, int t, string actions) {
    bool began = false, pressed = false;
    System.Threading.Thread work = new System.Threading.Thread(delegate() {
      try {
        AutomationElement root = AutomationElement.FromHandle(new IntPtr(window));
        foreach (AutomationElement found in root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.NameProperty, name))) {
          System.Windows.Rect r = found.Current.BoundingRectangle;
          if (Math.Abs(r.X - x) > 3 || Math.Abs(r.Y - y) > 3 || Math.Abs(r.Width - w) > 3 || Math.Abs(r.Height - t) > 3) continue;
          foreach (string action in actions.Split(',')) {
            object p;
            if (action == "invoke" && found.TryGetCurrentPattern(InvokePattern.Pattern, out p)) { began = true; ((InvokePattern)p).Invoke(); pressed = true; return; }
            if (action == "toggle" && found.TryGetCurrentPattern(TogglePattern.Pattern, out p)) { began = true; ((TogglePattern)p).Toggle(); pressed = true; return; }
            if (action == "select" && found.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) { began = true; ((SelectionItemPattern)p).Select(); pressed = true; return; }
            if (action == "expand" && found.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p)) {
              began = true;
              ExpandCollapsePattern opens = (ExpandCollapsePattern)p;
              if (opens.Current.ExpandCollapseState == ExpandCollapseState.Collapsed) opens.Expand(); else opens.Collapse();
              pressed = true;
              return;
            }
          }
        }
      } catch { }
    });
    work.IsBackground = true;
    work.Start();
    work.Join(6000);
    return pressed || began;
  }
  // "x,y,width,height,e or c,name" for each control that can open and close. A stuck app must
  // not hold up every other request here, so it answers with what it has in time, which may be nothing.
  public static string ExpandStates(long window) {
    string states = "";
    System.Threading.Thread work = new System.Threading.Thread(delegate() {
      try {
        AutomationElement root = AutomationElement.FromHandle(new IntPtr(window));
        CacheRequest cache = new CacheRequest();
        cache.AutomationElementMode = AutomationElementMode.None;
        cache.Add(AutomationElement.BoundingRectangleProperty);
        cache.Add(AutomationElement.NameProperty);
        cache.Add(ExpandCollapsePattern.ExpandCollapseStateProperty);
        AutomationElementCollection all;
        using (cache.Activate()) all = root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.IsExpandCollapsePatternAvailableProperty, true));
        List<string> rows = new List<string>();
        foreach (AutomationElement found in all) {
          object state = found.GetCachedPropertyValue(ExpandCollapsePattern.ExpandCollapseStateProperty);
          if (!(state is ExpandCollapseState)) continue;
          ExpandCollapseState now = (ExpandCollapseState)state;
          if (now == ExpandCollapseState.LeafNode) continue;
          System.Windows.Rect r = (System.Windows.Rect)found.GetCachedPropertyValue(AutomationElement.BoundingRectangleProperty);
          rows.Add((int)r.X + "," + (int)r.Y + "," + (int)r.Width + "," + (int)r.Height + "," + (now == ExpandCollapseState.Collapsed ? "c" : "e") + "," + ((string)found.GetCachedPropertyValue(AutomationElement.NameProperty)).Replace('\\r', ' ').Replace('\\n', ' '));
        }
        states = string.Join("\\u0001", rows);
      } catch { }
    });
    work.IsBackground = true;
    work.Start();
    work.Join(1500);
    return states;
  }
  // Whether a window of another app is on top at a point. With the app in front, a real click still
  // lands on an always-on-top window there, and that app was never given to the agent.
  public static bool OtherAppAt(long window, int x, int y) {
    IntPtr top = new IntPtr(window);
    IntPtr at = WindowFromPoint(new Point(x, y));
    if (at == IntPtr.Zero) return false;
    IntPtr root = GetAncestor(at, 2);
    if (root == top) return false;
    uint owner = OwnerOf(root);
    IntPtr storeApp = StoreAppWindow(top);
    return owner != OwnerOf(top) && (storeApp == IntPtr.Zero || owner != OwnerOf(storeApp));
  }
  public static long Front() { return GetForegroundWindow().ToInt64(); }
  public static bool Restore(long window) {
    IntPtr h = new IntPtr(window);
    uint me = GetCurrentThreadId();
    uint front = GetWindowThreadProcessId(GetForegroundWindow(), IntPtr.Zero);
    uint target = GetWindowThreadProcessId(h, IntPtr.Zero);
    AttachThreadInput(me, front, true);
    AttachThreadInput(me, target, true);
    BringWindowToTop(h);
    bool done = SetForegroundWindow(h);
    AttachThreadInput(me, target, false);
    AttachThreadInput(me, front, false);
    return done;
  }
  public static bool Visible(long window) {
    IntPtr h = new IntPtr(window);
    Rect r;
    if (!IsWindowVisible(h) || IsIconic(h) || !GetWindowRect(h, out r)) return false;
    int w = r.R - r.L, t = r.B - r.T, seen = 0;
    double[][] spots = { new[] { .5, .5 }, new[] { .2, .2 }, new[] { .8, .2 }, new[] { .2, .8 }, new[] { .8, .8 } };
    foreach (double[] s in spots) {
      Point p = new Point(r.L + (int)(w * s[0]), r.T + (int)(t * s[1]));
      if (GetAncestor(WindowFromPoint(p), 2) == h) seen++;
    }
    return seen >= 2;
  }
}
'@
[void][SideKickWindows]::SetProcessDPIAware()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $answer = $false
  try {
    $c = $line | ConvertFrom-Json
    switch ($c.op) {
      'text' { $answer = [SideKickWindows]::SendText([long]$c.window, [string]$c.text) }
      'key' { $answer = [SideKickWindows]::SendKey([long]$c.window, [int]$c.vk) }
      'wheel' { $answer = [SideKickWindows]::SendWheel([long]$c.window, [bool]$c.down, [int]$c.ticks, [int]$c.x, [int]$c.y) }
      'restore' { $answer = [SideKickWindows]::Restore([long]$c.window) }
      'visible' { $answer = [SideKickWindows]::Visible([long]$c.window) }
      'front' { $answer = [SideKickWindows]::Front() }
      'apps' { $answer = [SideKickWindows]::Apps() }
      'windows' { $answer = [SideKickWindows]::WindowsOf([uint32]$c.pid) }
      'path' { $answer = [SideKickWindows]::PathOf([uint32]$c.pid) }
      'ownedBy' { $answer = [SideKickWindows]::OwnedBy([long]$c.window) }
      'close' { $answer = [SideKickWindows]::CloseWindow([long]$c.window) }
      'popups' { $answer = [SideKickWindows]::Popups([long]$c.window) }
      'pointer' { $answer = [SideKickWindows]::Pointer() }
      'pointerTo' { $answer = [SideKickWindows]::PointerTo([int]$c.x, [int]$c.y) }
      'mouseButton' { $answer = [SideKickWindows]::MouseButton([string]$c.button, [bool]$c.down) }
      'keyState' { $answer = [SideKickWindows]::KeyState([int]$c.vk, [bool]$c.down) }
      'clipboardInfo' { $answer = [SideKickWindows]::ClipboardInfo() }
      'clipboardText' { $answer = [SideKickWindows]::ClipboardText([bool]$c.evenPrivate) }
      'clipboardWrite' { $answer = [SideKickWindows]::ClipboardWrite([string]$c.text, [bool]$c.notForHistory) }
      'clipboardSave' { $answer = [SideKickWindows]::ClipboardSave() }
      'clipboardRestore' { $answer = [SideKickWindows]::ClipboardRestore([long]$c.sequence) }
      'clipboardForget' { [SideKickWindows]::ClipboardForget(); $answer = $true }
      'screen' { $answer = [SideKickWindows]::Screen([int]$c.display, [int]$c.maxWidth, [string]$c.hidden) }
      'restoreBehind' { $answer = [SideKickWindows]::RestoreBehind([uint32]$c.pid) }
      'minimizeAgain' { $answer = [SideKickWindows]::MinimizeAgain([long]$c.window) }
      'start' {
        $info = New-Object System.Diagnostics.ProcessStartInfo ([string]$c.path)
        $info.UseShellExecute = $true
        if ($c.args) { $info.Arguments = [string]$c.args }
        if ($c.path -notlike 'shell:*') { $info.WorkingDirectory = [System.IO.Path]::GetDirectoryName([string]$c.path) }
        [void][System.Diagnostics.Process]::Start($info)
        $answer = $true
      }
      'ignoresClicks' { $answer = [SideKickWindows]::IgnoresPostedClicks([long]$c.window) }
      'webBased' { $answer = [SideKickWindows]::IsWebBased([long]$c.window) }
      'press' { $answer = [SideKickWindows]::PressControl([long]$c.window, [string]$c.label, [int]$c.x, [int]$c.y, [int]$c.width, [int]$c.height, [string]$c.actions) }
      'expandStates' { $answer = [SideKickWindows]::ExpandStates([long]$c.window) }
      'otherAppAt' { $answer = [SideKickWindows]::OtherAppAt([long]$c.window, [int]$c.x, [int]$c.y) }
      'at' {
        $found = [System.Windows.Automation.AutomationElement]::FromPoint((New-Object System.Windows.Point ([double]$c.x), ([double]$c.y)))
        $info = $found.Current
        $answer = if ($info.ProcessId -eq [int]$c.pid) { ([string]$info.ControlType.ProgrammaticName -replace '^ControlType\\.', '') + ' ' + ([string]$info.Name -replace '[\\r\\n]+', ' ') } else { '-' }
      }
    }
  } catch { $answer = $false }
  [Console]::Out.WriteLine($(if ($answer -is [bool]) { if ($answer) { 'yes' } else { 'no' } } else { [string]$answer }))
}
[SideKickWindows]::LetGoOfEverything()
`

// The script comes in as the first line of input: on the command line, Windows' limit of 32,767
// characters stopped it starting at all. Setting the encoding later would drop what is already read.
const HELPER_START =
  '[Console]::InputEncoding = New-Object Text.UTF8Encoding $false;' +
  '& ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine()))))'

const VIRTUAL_KEYS: Readonly<Record<string, number>> = {
  backspace: 0x08,
  tab: 0x09,
  return: 0x0d,
  enter: 0x0d,
  escape: 0x1b,
  esc: 0x1b,
  space: 0x20,
  pageup: 0x21,
  pagedown: 0x22,
  end: 0x23,
  home: 0x24,
  insert: 0x2d,
  left: 0x25,
  up: 0x26,
  right: 0x27,
  down: 0x28,
  delete: 0x2e
}

/** The Windows key code for a key's name, or null for one this path can't send. */
export function computerVirtualKey(name: string): number | null {
  const key = name.trim().toLowerCase()
  if (/^[a-z0-9]$/.test(key)) return key.toUpperCase().charCodeAt(0)
  const fn = /^f([1-9]|1[0-2])$/.exec(key)
  if (fn) return 0x6f + Number(fn[1])
  return VIRTUAL_KEYS[key] ?? null
}

const HOLDABLE_MODIFIERS: Readonly<Record<string, number>> = {
  shift: 0x10,
  ctrl: 0x11,
  control: 0x11,
  alt: 0x12
}

/** The key code for a key that can be held down, which also covers shift, ctrl and alt. */
export function computerHoldableKey(name: string): number | null {
  return HOLDABLE_MODIFIERS[name.trim().toLowerCase()] ?? computerVirtualKey(name)
}

export interface ComputerClipboardInfo {
  /** Changes whenever anything is put on the clipboard. */
  sequence: number
  /** The process that put it there, or 0 when Windows won't say. */
  owner: number
  hasText: boolean
  /** Marked by what copied it, as password managers do, to stay out of anything watching. */
  markedPrivate: boolean
}

/** A picture of one display, in which what must stay hidden is already blanked. */
export interface ComputerScreen {
  display: number
  displays: number
  /** Where the display is, in physical pixels. */
  bounds: ComputerWindowBounds
  width: number
  height: number
  data: string
  /** Each app's window on it, front first, in physical pixels. */
  windows: Array<{ path: string; bounds: ComputerWindowBounds; hidden: boolean }>
}

/** The helper's answer about the screen, or null for no picture. */
export function parseComputerScreen(answer: string): ComputerScreen | null {
  const found =
    /^(\d+),(\d+),(-?\d+),(-?\d+),(\d+),(\d+),(\d+),(\d+);([A-Za-z0-9+/=]*);([A-Za-z0-9+/=]+)$/.exec(
      answer
    )
  if (!found) return null
  const [display, displays, x, y, width, height, pictureWidth, pictureHeight] = found
    .slice(1, 9)
    .map(Number)
  const windows = Buffer.from(found[9], 'base64')
    .toString('utf8')
    .split('?')
    .flatMap((row) => {
      const parts = row.split('|')
      if (parts.length !== 6) return []
      const [left, top, right, bottom] = parts.slice(1, 5).map(Number)
      return [
        {
          path: parts[0],
          bounds: { x: left, y: top, width: right - left, height: bottom - top },
          hidden: parts[5] === '1'
        }
      ]
    })
  return {
    display,
    displays,
    bounds: { x, y, width, height },
    width: pictureWidth,
    height: pictureHeight,
    data: found[10],
    windows
  }
}

/** A menu or dropdown open over a window, in physical pixels. */
export interface ComputerPopup {
  x: number
  y: number
  width: number
  height: number
  data: string
}

export interface ComputerAppWindow {
  id: number
  /** The process that owns the window, when that isn't the app, as a Store app's host does. */
  owner?: number
  title: string
  /** In physical pixels, as Windows reports them; null when it reports nothing to outline. */
  bounds: ComputerWindowBounds | null
}

/** The helper's answer, largest window first: an app's first one can be a small helper of its own. */
export function parseComputerWindows(answer: string, app: number): ComputerAppWindow[] {
  const area = (window: ComputerAppWindow): number =>
    (window.bounds?.width ?? 0) * (window.bounds?.height ?? 0)
  return answer
    .split('\u0001')
    .flatMap((row) => {
      const found = /^(\d+),(\d+),(-?\d+),(-?\d+),(\d+),(\d+),(.+)$/s.exec(row)
      if (!found) return []
      const [x, y, width, height] = found.slice(3, 7).map(Number)
      const owner = Number(found[2])
      return [
        {
          id: Number(found[1]),
          ...(owner !== app ? { owner } : {}),
          title: found[7],
          bounds: width > 0 && height > 0 ? { x, y, width, height } : null
        }
      ]
    })
    .sort((a, b) => area(b) - area(a))
}

/**
 * One long-lived helper, since starting PowerShell for each step would be slow. It only ever acts on
 * window handles the service got from the driver for an app the user approved, and goes away when idle.
 */
export class ComputerUseWindows {
  private child: ChildProcessWithoutNullStreams | null = null
  private waiting: Array<(answer: string) => void> = []
  private idle: ReturnType<typeof setTimeout> | null = null
  /** It holds what the user had copied, which going away would lose. */
  private holdingClipboard = false

  private start(): ChildProcessWithoutNullStreams {
    const child = spawn(
      powershellPath(),
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(HELPER_START, 'utf16le').toString('base64')
      ],
      { windowsHide: true, stdio: 'pipe' }
    )
    child.stdin.write(`${Buffer.from(HELPER_SCRIPT, 'utf8').toString('base64')}\n`)
    createInterface({ input: child.stdout }).on('line', (line) => {
      this.waiting.shift()?.(line.trim())
    })
    child.stderr.resume()
    const gone = (): void => {
      if (this.child === child) {
        this.child = null
        this.holdingClipboard = false
      }
      for (const answer of this.waiting.splice(0)) answer('no')
    }
    child.on('error', gone)
    child.on('exit', gone)
    child.stdin.on('error', () => undefined)
    return child
  }

  private ask(request: Record<string, unknown>): Promise<string> {
    this.child ??= this.start()
    this.waitToClose()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // Answers come back in order, so one that never came means the helper is stuck.
        this.close()
        resolve('no')
      }, REQUEST_TIMEOUT_MS)
      this.waiting.push((answer) => {
        clearTimeout(timer)
        resolve(answer)
      })
      this.child!.stdin.write(`${JSON.stringify(request)}\n`)
    })
  }

  private waitToClose(): void {
    if (this.idle) clearTimeout(this.idle)
    this.idle = setTimeout(() => {
      if (this.holdingClipboard) this.waitToClose()
      else this.close()
    }, HELPER_IDLE_MS)
  }

  private async confirm(request: Record<string, unknown>): Promise<boolean> {
    return (await this.ask(request)) === 'yes'
  }

  text(window: number, text: string): Promise<boolean> {
    return this.confirm({ op: 'text', window, text })
  }

  key(window: number, vk: number): Promise<boolean> {
    return this.confirm({ op: 'key', window, vk })
  }

  wheel(
    window: number,
    direction: 'up' | 'down',
    ticks: number,
    point: { x: number; y: number }
  ): Promise<boolean> {
    return this.confirm({ op: 'wheel', window, down: direction === 'down', ticks, ...point })
  }

  /**
   * The apps with a window open. Window titles stay out: one can hold a document's name or an email's
   * subject, and the agent has not been given those apps. An elevated app reports no path, so it is
   * left out; Windows would refuse its input anyway.
   */
  async apps(): Promise<ComputerApp[]> {
    const answer = await this.ask({ op: 'apps' })
    if (answer === 'no') throw new Error('Windows did not say which apps are open.')
    return parseComputerApps(answer)
  }

  async windowsOf(pid: number): Promise<ComputerAppWindow[]> {
    return parseComputerWindows(await this.ask({ op: 'windows', pid }), pid)
  }

  /** Dialogs a window owns, each with the process it belongs to as its `owner`. */
  async ownedBy(window: number): Promise<ComputerAppWindow[]> {
    return parseComputerWindows(await this.ask({ op: 'ownedBy', window }), 0)
  }

  /** Asks a window to close, as its close button would. Only for one SideKick itself opened. */
  closeWindow(window: number): Promise<boolean> {
    return this.confirm({ op: 'close', window })
  }

  async popups(window: number): Promise<ComputerPopup[]> {
    return (await this.ask({ op: 'popups', window })).split(';').flatMap((row) => {
      const found = /^(-?\d+),(-?\d+),(\d+),(\d+),([A-Za-z0-9+/=]+)$/.exec(row)
      if (!found) return []
      const [x, y, width, height] = found.slice(1, 5).map(Number)
      return [{ x, y, width, height, data: found[5] }]
    })
  }

  /** A process's executable, or '' if Windows won't say. */
  async pathOf(pid: number): Promise<string> {
    const answer = await this.ask({ op: 'path', pid })
    return answer === 'no' ? '' : answer
  }

  /** Brings an app's minimized window back behind everything else. Its id, or 0 if it has none. */
  async restoreBehind(pid: number): Promise<number> {
    return Number(await this.ask({ op: 'restoreBehind', pid })) || 0
  }

  minimizeAgain(window: number): Promise<boolean> {
    return this.confirm({ op: 'minimizeAgain', window })
  }

  /** Where the real pointer is, or null if Windows won't say. */
  async pointer(): Promise<{ x: number; y: number } | null> {
    const found = /^(-?\d+),(-?\d+)$/.exec(await this.ask({ op: 'pointer' }))
    return found ? { x: Number(found[1]), y: Number(found[2]) } : null
  }

  /** Moves the real pointer. Only for real input, once the user has stepped away. */
  pointerTo(point: { x: number; y: number }): Promise<boolean> {
    return this.confirm({ op: 'pointerTo', ...point })
  }

  /** Presses or lets go of a real mouse button where the pointer is. Only once the user has stepped away. */
  mouseButton(button: string, down: boolean): Promise<boolean> {
    return this.confirm({ op: 'mouseButton', button, down })
  }

  /** Presses or lets go of a real key. Only once the user has stepped away. */
  keyState(vk: number, down: boolean): Promise<boolean> {
    return this.confirm({ op: 'keyState', vk, down })
  }

  async clipboardInfo(): Promise<ComputerClipboardInfo | null> {
    const found = /^(\d+),(\d+),([01]),([01])$/.exec(await this.ask({ op: 'clipboardInfo' }))
    if (!found) return null
    return {
      sequence: Number(found[1]),
      owner: Number(found[2]),
      hasText: found[3] === '1',
      markedPrivate: found[4] === '1'
    }
  }

  /** The clipboard's text and its sequence number, or null if it holds none it may give. */
  async clipboardText(evenPrivate: boolean): Promise<{ sequence: number; text: string } | null> {
    const found = /^(\d+),([A-Za-z0-9+/=]*)$/.exec(
      await this.ask({ op: 'clipboardText', evenPrivate })
    )
    return found
      ? { sequence: Number(found[1]), text: Buffer.from(found[2], 'base64').toString('utf8') }
      : null
  }

  /** Puts text on the clipboard. The sequence number it then has, or 0 if Windows refused. */
  async clipboardWrite(text: string, notForHistory: boolean): Promise<number> {
    const base64 = Buffer.from(text, 'utf8').toString('base64')
    return Number(await this.ask({ op: 'clipboardWrite', text: base64, notForHistory })) || 0
  }

  /** Keeps what is on the clipboard inside the helper, to put back later. False if it is too much. */
  async clipboardSave(): Promise<boolean> {
    const saved = await this.confirm({ op: 'clipboardSave' })
    if (saved) this.holdingClipboard = true
    return saved
  }

  /** Puts back what was kept, unless anything has been copied since the given sequence number. */
  clipboardRestore(sequence: number): Promise<boolean> {
    this.holdingClipboard = false
    return this.confirm({ op: 'clipboardRestore', sequence })
  }

  clipboardForget(): Promise<boolean> {
    this.holdingClipboard = false
    return this.confirm({ op: 'clipboardForget' })
  }

  /** A picture of one display with the named executables blanked out, or null if there is none. */
  async screen(
    display: number,
    maxWidth: number,
    hidden: readonly string[]
  ): Promise<ComputerScreen | null> {
    return parseComputerScreen(
      await this.ask({ op: 'screen', display, maxWidth, hidden: hidden.join(',') })
    )
  }

  restore(window: number): Promise<boolean> {
    return this.confirm({ op: 'restore', window })
  }

  visible(window: number): Promise<boolean> {
    return this.confirm({ op: 'visible', window })
  }

  /**
   * The control at a screen point, as "Button Delete", or '' when it can't be told. Windows can only
   * say what is on top there, so an app that is covered gets no answer.
   */
  async controlAt(pid: number, point: { x: number; y: number }): Promise<string> {
    const answer = await this.ask({ op: 'at', pid, ...point })
    return answer === 'no' || answer === '-' ? '' : answer
  }

  /**
   * Starts an app through the Windows shell, with no arguments: an executable, or a Store app's
   * `shell:AppsFolder` entry. Started directly, it would inherit SideKick's open handles: an Excel
   * started that way kept SideKick's debugging port open after SideKick had closed, so the next start
   * couldn't have it.
   */
  launch(path: string, args: readonly string[] = []): Promise<boolean> {
    return this.confirm({ op: 'start', path, args: args.join(' ') })
  }

  ignoresPostedClicks(window: number): Promise<boolean> {
    return this.confirm({ op: 'ignoresClicks', window })
  }

  isWebBased(window: number): Promise<boolean> {
    return this.confirm({ op: 'webBased', window })
  }

  /** Presses a row's control through UI Automation. False if it isn't there to press. */
  pressControl(
    window: number,
    control: { label: string; frame: ComputerWindowBounds; actions: readonly string[] }
  ): Promise<boolean> {
    return this.confirm({
      op: 'press',
      window,
      label: control.label,
      ...control.frame,
      actions: control.actions.join(',')
    })
  }

  /** The state of a window's controls that can open and close, if it answers in time. */
  async expandStates(window: number): Promise<ComputerExpandState[]> {
    return (await this.ask({ op: 'expandStates', window })).split('\u0001').flatMap((row) => {
      const found = /^(-?\d+),(-?\d+),(\d+),(\d+),([ec]),(.*)$/s.exec(row)
      if (!found) return []
      const [x, y, width, height] = found.slice(1, 5).map(Number)
      return [{ x, y, width, height, expanded: found[5] === 'e', label: found[6] }]
    })
  }

  /** Whether another app's window would take a real click at a screen point. */
  otherAppAt(window: number, point: { x: number; y: number }): Promise<boolean> {
    return this.confirm({ op: 'otherAppAt', window, ...point })
  }

  /** The window in front, or 0 when that can't be told. */
  async front(): Promise<number> {
    return Number(await this.ask({ op: 'front' })) || 0
  }

  close(): void {
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
    const child = this.child
    this.child = null
    child?.stdin.end()
  }
}
