const identity = require('./src/shared/productIdentity.json')

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: identity.appId,
  productName: identity.productName,
  publish: null,
  directories: {
    buildResources: 'build'
  },
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
  asarUnpack: ['resources/**'],
  win: {
    executableName: identity.productName,
    icon: 'build/icon.ico',
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
    createDesktopShortcut: 'always'
  },
  mac: {
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
