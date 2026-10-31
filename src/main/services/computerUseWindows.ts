import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { createInterface } from 'readline'
import { powershellPath } from './computerUseApps'

const HELPER_IDLE_MS = 60_000
const REQUEST_TIMEOUT_MS = 10_000

// Windows messages to an app's own page window, which web-based apps accept without focus and the
// driver doesn't send. Chromium takes keys on its page window but ignores a wheel there while covered.
// WebView2 apps drawn through a composition host are the other way round: wheel, but no keys.
const HELPER_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object Text.UTF8Encoding $false
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
  const uint WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101, WM_CHAR = 0x0102, WM_MOUSEWHEEL = 0x020A;
  const int VK_PRIOR = 0x21, VK_NEXT = 0x22;
  static string ClassOf(IntPtr h) {
    StringBuilder s = new StringBuilder(128);
    GetClassName(h, s, 128);
    return s.ToString();
  }
  // The largest one that shows: a browser keeps a page window for each of its other tabs too.
  static IntPtr Child(IntPtr top, string name) {
    IntPtr found = IntPtr.Zero;
    long largest = -1;
    EnumChildWindows(top, delegate(IntPtr c, IntPtr l) {
      Rect r;
      if (ClassOf(c) == name && IsWindowVisible(c) && GetWindowRect(c, out r)) {
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
    IntPtr page = ChromiumPage(window);
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
      'ignoresClicks' { $answer = [SideKickWindows]::IgnoresPostedClicks([long]$c.window) }
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
        Buffer.from(HELPER_SCRIPT, 'utf16le').toString('base64')
      ],
      { windowsHide: true, stdio: 'pipe' }
    )
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
