const identity = require('./src/shared/productIdentity.json')

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: identity.appId,
  productName: identity.productName,
  publish: null,
  directories: {
    buildResources: 'build'
  },
  beforePack: 'scripts/fetch-computer-driver.cjs',
  afterSign: 'scripts/after-sign.cjs',
  files: [
    // Ship only reviewed runtime roots; ignored reports and local agent state
    // must not become installer content merely because a developer generated them.
    'out/**/*',
    'resources/**/*',
    'package.json',
    'LICENSE',
    // Local Python helper runs must not ship interpreter-specific caches or
    // embedded developer paths in bytecode alongside the reviewed skill source.
    '!**/__pycache__{,/**/*}',
    '!**/*.{pyc,pyo}',
    // Dormant XSD-era validators are not used by the supported structural helpers.
    '!resources/skills/office/validators{,/**/*}',
    '!**/.vscode/*',
    '!.claude{,/**/*}',
    '!.github{,/**/*}',
    '!coverage{,/**/*}',
    '!output{,/**/*}',
    '!reports{,/**/*}',
    '!tmp{,/**/*}',
    '!docs{,/**/*}',
    '!scripts{,/**/*}',
    '!src/*',
    '!electron.vite.config.{js,ts,mjs,cjs}',
    '!electron-builder.config.cjs',
    '!{.eslintcache,eslint.config.mjs,.prettierignore,.prettierrc.yaml}',
    '!*.md',
    '!{.env,.env.*,.npmrc,pnpm-lock.yaml}',
    '!{tsconfig.json,tsconfig.node.json,tsconfig.web.json}'
  ],
  // sherpa-onnx loads native libraries that the OS cannot read from inside app.asar, and
  // node-pty starts its own helpers (Windows' console host, a macOS spawn helper) from disk.
  asarUnpack: ['resources/**', '**/node_modules/sherpa-onnx-*/**', '**/node_modules/node-pty/**'],
  win: {
    executableName: identity.productName,
    icon: 'build/icon.ico',
    // `bin` beside the executable holds the `sidekick` command; the installer puts it on PATH.
    extraFiles: [{ from: 'build/cli/win', to: 'bin' }],
    // The driver behind computer use, verified by scripts/fetch-computer-driver.cjs.
    extraResources: [{ from: 'build/computer-driver', to: 'computer-driver' }],
    target: [
      {
        target: 'nsis',
        arch: ['x64']
      }
    ]
  },
  nsis: {
    artifactName: '${productName}-${version}-windows-x64-setup.${ext}',
    shortcutName: identity.productName,
    uninstallDisplayName: identity.productName,
    createDesktopShortcut: 'always',
    // Shown on a first install only; an update skips it. Code signing through SignPath
    // Foundation requires the privacy terms to be shown during installation.
    license: 'build/installer-notice.txt',
    include: 'build/installer.nsh'
  },
  // The Microsoft Store package. Partner Center assigns the identity and publisher when the app
  // name is reserved; `npm run build:store` reads them from the environment. The Store signs the
  // package it distributes, so it is never built for or attached to a GitHub release.
  appx: {
    identityName: process.env.SIDEKICK_STORE_IDENTITY_NAME,
    publisher: process.env.SIDEKICK_STORE_PUBLISHER,
    publisherDisplayName: process.env.SIDEKICK_STORE_PUBLISHER_DISPLAY_NAME,
    applicationId: identity.productName,
    // The Store requires the name reserved in Partner Center, which may differ from the app's.
    displayName: process.env.SIDEKICK_STORE_DISPLAY_NAME || identity.productName,
    // The tile images are transparent, so Start draws them on the user's accent colour.
    backgroundColor: 'transparent',
    languages: ['en-US'],
    // The Store refuses an MSIX for Windows 10 1803 (10.0.17134) or older, and electron-builder
    // defaults to 1607. 1809 is the oldest Windows 10 release Electron still supports.
    minVersion: '10.0.17763.0',
    maxVersionTested: '10.0.26100.0',
    artifactName: '${productName}-${version}-windows-x64-store.${ext}'
  },
  mac: {
    // Explicit ad-hoc signing also works when CI disables identity discovery.
    identity: '-',
    artifactName: '${productName}-${version}-macos-${arch}.${ext}',
    icon: 'build/icon.icns',
    hardenedRuntime: true,
    entitlements: 'build/entitlements.mac.plist',
    target: [
      { target: 'dmg', arch: ['arm64'] },
      { target: 'zip', arch: ['arm64'] }
    ],
    entitlementsInherit: 'build/entitlements.mac.plist',
    extendInfo: {
      NSCameraUsageDescription: 'Application requests access to the device camera.',
      NSMicrophoneUsageDescription: 'Application requests access to the device microphone.',
      NSDocumentsFolderUsageDescription:
        'Application requests access to the user Documents folder.',
      NSDownloadsFolderUsageDescription: 'Application requests access to the user Downloads folder.'
    }
  },
  dmg: {
    writeUpdateInfo: false
  },
  linux: {
    artifactName: '${productName}-${version}-linux-x64.${ext}',
    icon: 'build/icon.svg',
    category: 'Development',
    executableName: identity.appId,
    syncDesktopName: true,
    desktop: {
      entry: {
        Name: identity.productName,
        Comment: 'Local-first desktop agent for your own model providers and projects',
        Categories: 'Development;',
        StartupWMClass: identity.appId,
        Terminal: false,
        Type: 'Application'
      }
    },
    target: [
      {
        target: 'AppImage',
        arch: ['x64']
      }
    ]
  },
  toolsets: {
    appimage: '1.0.3'
  },
  npmRebuild: false
}
