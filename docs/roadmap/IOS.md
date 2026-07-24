# iPhone and iPad roadmap

SideKick will not pay for the Apple Developer Program, App Store distribution, TestFlight, or a
commercial signing service. Under that permanent constraint, a native public iOS application is
not a sustainable release target.

## Production direction

The production mobile route is an installable web app (PWA) designed for iPhone and iPad. Safari
can add a site to the Home Screen, launch it as a standalone web app, and support Web Push after the
user installs it. This route does not require SideKick to join the Apple Developer Program.

A useful SideKick PWA would need:

- an offline-capable application shell with deliberate cache and migration behavior;
- encrypted local state appropriate to browser storage limitations;
- ordinary chat, provider connections, research, plans, goals, and narrowly scoped remote MCP
  capabilities;
- no promise of desktop filesystem, shell, Electron, or native background-process parity;
- a documented browser security model, data export/deletion, and recovery path;
- a free static or self-hostable deployment design with no SideKick subscription or hosted-account
  dependency.

## Native builds

Contributors may use Xcode's free Personal Team for local experiments. Those builds are temporary:
free provisioning expires after seven days and has small device limits. It is not a public release,
update, or support channel and must never become a production dependency.

If Apple later provides a genuinely free native public-distribution route, it can be evaluated as a
new architecture. Until then, SideKick should not maintain an App Store/TestFlight code path that
the project cannot ship.

References:

- [Apple membership comparison](https://developer.apple.com/support/compare-memberships/)
- [Add a website to the iPhone Home Screen](https://support.apple.com/guide/iphone/iphea86e5236/ios)
- [Web Push for Home Screen web apps](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
