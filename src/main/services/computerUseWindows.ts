import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { createInterface } from 'readline'
import { parseComputerApps, powershellPath, type ComputerApp } from './computerUseApps'
import type { ComputerWindowBounds } from './computerUseDriver'

// Starting it compiles its code, which takes a second or two, and a model's turn can outlast a minute.
const HELPER_IDLE_MS = 3 * 60_000
const REQUEST_TIMEOUT_MS = 10_000

// Windows messages to an app's own page window, which web-based apps accept without focus and the
// driver doesn't send. Chromium takes keys on its page window but ignores a wheel there while covered.
// WebView2 apps drawn through a composition host are the other way round: wheel, but no keys.
const HELPER_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
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
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out Point p);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int n);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out Rect v, int n);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint a, bool i, uint p);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, uint f, StringBuilder s, ref uint n);
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
  static string PathOf(uint pid) {
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
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (IsWindowVisible(h) && GetWindow(h, 4) == IntPtr.Zero && !paths.ContainsKey(pid)) {
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
      uint owner;
      Rect r;
      int cloaked;
      GetWindowThreadProcessId(h, out owner);
      if (owner != pid || !IsWindowVisible(h) || IsIconic(h) || !GetWindowRect(h, out r)) return true;
      if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      // What shows: a window's own rectangle has invisible borders, which pictures of it leave out.
      Rect frame;
      if (DwmGetWindowAttribute(h, 9, out frame, 16) == 0) r = frame;
      StringBuilder title = new StringBuilder(512);
      GetWindowText(h, title, 512);
      string text = title.ToString().Replace('\\r', ' ').Replace('\\n', ' ').Replace('\\u0001', ' ');
      if (text == "" || text == "Program Manager") return true;
      all.Append(h.ToInt64()).Append(',').Append(r.L).Append(',').Append(r.T).Append(',').Append(r.R - r.L).Append(',').Append(r.B - r.T).Append(',').Append(text).Append('\\u0001');
      return true;
    }, IntPtr.Zero);
    return all.ToString();
  }
  // A minimized app can't be read or clicked. This brings its largest window back behind everything
  // else, without focus, so nothing changes for whoever is using the computer. 0 if it has none.
  public static long RestoreBehind(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint owner;
      GetWindowThreadProcessId(h, out owner);
      if (owner == pid && found == IntPtr.Zero && IsWindowVisible(h) && IsIconic(h)) {
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
  // The real pointer travels, so it never jumps and the app sees it arrive before anything is pressed.
  public static bool Glide(int x, int y) {
    Point from;
    if (!GetCursorPos(out from)) return false;
    for (int i = 1; i <= 16; i++) {
      double t = i / 16.0, eased = t < 0.5 ? 2 * t * t : 1 - (2 - 2 * t) * (2 - 2 * t) / 2;
      SetCursorPos(from.X + (int)((x - from.X) * eased), from.Y + (int)((y - from.Y) * eased));
      System.Threading.Thread.Sleep(14);
    }
    return true;
  }
  public static bool IsChromium(long window) { return ClassOf(new IntPtr(window)).StartsWith("Chrome_WidgetWin"); }
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
      'glide' { $answer = [SideKickWindows]::Glide([int]$c.x, [int]$c.y) }
      'restoreBehind' { $answer = [SideKickWindows]::RestoreBehind([uint32]$c.pid) }
      'minimizeAgain' { $answer = [SideKickWindows]::MinimizeAgain([long]$c.window) }
      'start' {
        $info = New-Object System.Diagnostics.ProcessStartInfo ([string]$c.path)
        $info.UseShellExecute = $true
        $info.WorkingDirectory = [System.IO.Path]::GetDirectoryName([string]$c.path)
        [void][System.Diagnostics.Process]::Start($info)
        $answer = $true
      }
      'ignoresClicks' { $answer = [SideKickWindows]::IgnoresPostedClicks([long]$c.window) }
      'chromium' { $answer = [SideKickWindows]::IsChromium([long]$c.window) }
      'at' {
        $found = [System.Windows.Automation.AutomationElement]::FromPoint((New-Object System.Windows.Point ([double]$c.x), ([double]$c.y)))
        $info = $found.Current
        $answer = if ($info.ProcessId -eq [int]$c.pid) { ([string]$info.ControlType.ProgrammaticName -replace '^ControlType\\.', '') + ' ' + ([string]$info.Name -replace '[\\r\\n]+', ' ') } else { '-' }
      }
    }
  } catch { $answer = $false }
  [Console]::Out.WriteLine($(if ($answer -is [bool]) { if ($answer) { 'yes' } else { 'no' } } else { [string]$answer }))
}
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

export interface ComputerAppWindow {
  id: number
  title: string
  /** In physical pixels, as Windows reports them; null when it reports nothing to outline. */
  bounds: ComputerWindowBounds | null
}

/** The helper's answer, largest window first: an app's first one can be a small helper of its own. */
export function parseComputerWindows(answer: string): ComputerAppWindow[] {
  const area = (window: ComputerAppWindow): number =>
    (window.bounds?.width ?? 0) * (window.bounds?.height ?? 0)
  return answer
    .split('\u0001')
    .flatMap((row) => {
      const found = /^(\d+),(-?\d+),(-?\d+),(\d+),(\d+),(.+)$/s.exec(row)
      if (!found) return []
      const [x, y, width, height] = found.slice(2, 6).map(Number)
      return [
        {
          id: Number(found[1]),
          title: found[6],
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
      if (this.child === child) this.child = null
      for (const answer of this.waiting.splice(0)) answer('no')
    }
    child.on('error', gone)
    child.on('exit', gone)
    child.stdin.on('error', () => undefined)
    return child
  }

  private ask(request: Record<string, unknown>): Promise<string> {
    this.child ??= this.start()
    if (this.idle) clearTimeout(this.idle)
    this.idle = setTimeout(() => this.close(), HELPER_IDLE_MS)
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
    return parseComputerWindows(await this.ask({ op: 'windows', pid }))
  }

  /** Brings an app's minimized window back behind everything else. Its id, or 0 if it has none. */
  async restoreBehind(pid: number): Promise<number> {
    return Number(await this.ask({ op: 'restoreBehind', pid })) || 0
  }

  minimizeAgain(window: number): Promise<boolean> {
    return this.confirm({ op: 'minimizeAgain', window })
  }

  /** Moves the real pointer to a screen point. Only for real input, once the user has stepped away. */
  glide(point: { x: number; y: number }): Promise<boolean> {
    return this.confirm({ op: 'glide', ...point })
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
   * Starts an app through the Windows shell, with no arguments. Started directly, it would inherit
   * SideKick's open handles: an Excel started that way kept SideKick's debugging port open after
   * SideKick had closed, so the next start couldn't have it.
   */
  launch(path: string): Promise<boolean> {
    return this.confirm({ op: 'start', path })
  }

  /** Chromium and Electron windows, where a drag sent in the background moves nothing. */
  ignoresBackgroundDrags(window: number): Promise<boolean> {
    return this.confirm({ op: 'chromium', window })
  }

  ignoresPostedClicks(window: number): Promise<boolean> {
    return this.confirm({ op: 'ignoresClicks', window })
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
