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
    '!**/.vscode/*',
    '!.claude{,/**/*}',
    '!.github{,/**/*}',
    '!coverage{,/**/*}',
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
    icon: 'resources/icon.ico',
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
    artifactName: '${productName}-${version}-${arch}.${ext}',
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
  npmRebuild: false
}
