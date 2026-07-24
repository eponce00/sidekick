const { execFileSync } = require('node:child_process')
const { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { homedir, tmpdir } = require('node:os')
const { join } = require('node:path')

const LOCAL_IDENTITY = 'SideKick Local Development'
const LOCAL_KEYCHAIN_PASSWORD = 'sidekick-local-signing-v1'
const LOCAL_KEYCHAIN = join(homedir(), 'Library', 'Keychains', 'sidekick-local-signing.keychain-db')

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: options.quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit'
  })
}

function currentUserKeychains() {
  const output = run('/usr/bin/security', ['list-keychains', '-d', 'user'], { quiet: true })
  return [...output.matchAll(/"([^"]+)"/g)].map((match) => match[1])
}

function setUserKeychains(paths) {
  run('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', ...paths], { quiet: true })
}

function createLocalSigningIdentity() {
  const signingDirectory = mkdtempSync(join(tmpdir(), 'sidekick-local-signing-'))
  const rootKey = join(signingDirectory, 'root-key.pem')
  const rootCertificate = join(signingDirectory, 'root-certificate.pem')
  const leafKey = join(signingDirectory, 'leaf-key.pem')
  const leafRequest = join(signingDirectory, 'leaf.csr')
  const leafCertificate = join(signingDirectory, 'leaf-certificate.pem')
  const extensions = join(signingDirectory, 'leaf-extensions.cnf')
  const identityBundle = join(signingDirectory, 'identity.p12')

  try {
    run(
      '/usr/bin/openssl',
      [
        'req',
        '-new',
        '-newkey',
        'rsa:2048',
        '-x509',
        '-nodes',
        '-days',
        '3650',
        '-subj',
        '/CN=SideKick Local Root',
        '-addext',
        'basicConstraints=critical,CA:TRUE',
        '-addext',
        'keyUsage=critical,keyCertSign,cRLSign',
        '-keyout',
        rootKey,
        '-out',
        rootCertificate
      ],
      { quiet: true }
    )
    run(
      '/usr/bin/openssl',
      [
        'req',
        '-new',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-subj',
        `/CN=${LOCAL_IDENTITY}`,
        '-keyout',
        leafKey,
        '-out',
        leafRequest
      ],
      { quiet: true }
    )
    writeFileSync(
      extensions,
      [
        'basicConstraints=critical,CA:FALSE',
        'keyUsage=critical,digitalSignature',
        'extendedKeyUsage=codeSigning'
      ].join('\n')
    )
    run(
      '/usr/bin/openssl',
      [
        'x509',
        '-req',
        '-days',
        '3650',
        '-in',
        leafRequest,
        '-CA',
        rootCertificate,
        '-CAkey',
        rootKey,
        '-CAcreateserial',
        '-extfile',
        extensions,
        '-out',
        leafCertificate
      ],
      { quiet: true }
    )
    run(
      '/usr/bin/openssl',
      [
        'pkcs12',
        '-export',
        '-out',
        identityBundle,
        '-inkey',
        leafKey,
        '-in',
        leafCertificate,
        '-certfile',
        rootCertificate,
        '-passout',
        `pass:${LOCAL_KEYCHAIN_PASSWORD}`
      ],
      { quiet: true }
    )

    mkdirSync(join(homedir(), 'Library', 'Keychains'), { recursive: true })
    run('/usr/bin/security', ['create-keychain', '-p', LOCAL_KEYCHAIN_PASSWORD, LOCAL_KEYCHAIN], {
      quiet: true
    })
    run('/usr/bin/security', ['unlock-keychain', '-p', LOCAL_KEYCHAIN_PASSWORD, LOCAL_KEYCHAIN], {
      quiet: true
    })
    run(
      '/usr/bin/security',
      [
        'import',
        identityBundle,
        '-k',
        LOCAL_KEYCHAIN,
        '-P',
        LOCAL_KEYCHAIN_PASSWORD,
        '-T',
        '/usr/bin/codesign'
      ],
      { quiet: true }
    )
    run(
      '/usr/bin/security',
      [
        'add-trusted-cert',
        '-r',
        'trustRoot',
        '-p',
        'codeSign',
        '-k',
        LOCAL_KEYCHAIN,
        rootCertificate
      ],
      { quiet: true }
    )
    run(
      '/usr/bin/security',
      [
        'set-key-partition-list',
        '-S',
        'apple-tool:,apple:',
        '-s',
        '-k',
        LOCAL_KEYCHAIN_PASSWORD,
        LOCAL_KEYCHAIN
      ],
      { quiet: true }
    )
    run('/usr/bin/security', ['set-keychain-settings', '-lut', '21600', LOCAL_KEYCHAIN], {
      quiet: true
    })
  } finally {
    rmSync(signingDirectory, { recursive: true, force: true })
  }
}

function localIdentityAvailable() {
  const output = run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], {
    quiet: true
  })
  return output.includes(`"${LOCAL_IDENTITY}"`)
}

function signWithPersistentLocalIdentity(appPath, entitlementsPath) {
  if (!existsSync(LOCAL_KEYCHAIN)) createLocalSigningIdentity()

  run('/usr/bin/security', ['unlock-keychain', '-p', LOCAL_KEYCHAIN_PASSWORD, LOCAL_KEYCHAIN], {
    quiet: true
  })
  run('/usr/bin/codesign', [
    '--force',
    '--deep',
    '--options',
    'runtime',
    '--entitlements',
    entitlementsPath,
    '--keychain',
    LOCAL_KEYCHAIN,
    '--sign',
    LOCAL_IDENTITY,
    appPath
  ])
}

/**
 * Public community builds are deliberately ad-hoc signed: SideKick never
 * requires a paid Apple Developer identity. Repeated local packages use one
 * laptop-local self-signed identity so Chromium Safe Storage does not treat
 * every rebuild as a different application.
 */
exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  if (process.env.CI === 'true') {
    const releaseEntitlementsPath = join(
      context.packager.info.buildResourcesDir,
      'entitlements.mac.plist'
    )
    run('/usr/bin/codesign', [
      '--force',
      '--deep',
      '--options',
      'runtime',
      '--entitlements',
      releaseEntitlementsPath,
      '--sign',
      '-',
      appPath
    ])
    return
  }

  const entitlementsPath = join(context.packager.info.buildResourcesDir, 'entitlements.mac.plist')
  const originalKeychains = currentUserKeychains()
  const signingKeychains = [
    LOCAL_KEYCHAIN,
    ...originalKeychains.filter((path) => path !== LOCAL_KEYCHAIN)
  ]

  try {
    if (!existsSync(LOCAL_KEYCHAIN)) createLocalSigningIdentity()
    setUserKeychains(signingKeychains)
    if (!localIdentityAvailable()) {
      run('/usr/bin/security', ['delete-keychain', LOCAL_KEYCHAIN], { quiet: true })
      createLocalSigningIdentity()
      setUserKeychains(signingKeychains)
    }
    if (!localIdentityAvailable()) throw new Error('Local signing identity is not trusted')
    signWithPersistentLocalIdentity(appPath, entitlementsPath)
  } catch (error) {
    console.warn('[Local signing] Persistent identity failed; using an ad-hoc signature.', error)
    run('/usr/bin/codesign', [
      '--force',
      '--deep',
      '--options',
      'runtime',
      '--entitlements',
      entitlementsPath,
      '--sign',
      '-',
      appPath
    ])
  } finally {
    setUserKeychains(originalKeychains)
  }
}
