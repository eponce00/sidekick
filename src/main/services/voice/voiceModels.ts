import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { VoiceModelId, VoiceModelState } from '../../../shared/voice'

export interface VoiceModelFile {
  name: string
  url: string
  size: number
  sha256: string
}

export interface VoiceModelManifest {
  id: VoiceModelId
  /** Folder under the models root; a new revision downloads beside the old one. */
  folder: string
  files: VoiceModelFile[]
}

const PARAKEET =
  'https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/resolve/2bda32ec70b097a55adaa07d9a7173915b43cc78'
const KOKORO =
  'https://huggingface.co/csukuangfj/kokoro-multi-lang-v1_0/resolve/f7b96bb6bef5c5da4d3aa4f4e0498fbbf62dc78b'

/**
 * Pinned to exact revisions and hashes: a model that changes upstream is
 * refused rather than loaded. Parakeet TDT 0.6B v3 (CC-BY-4.0, NVIDIA) for
 * dictation with Silero VAD (MIT) to find speech; Kokoro 82M v1.0 (Apache-2.0,
 * hexgrad) to read replies aloud, with the espeak-ng data (GPL-3.0) for the
 * languages it reads.
 */
export const VOICE_MODELS: Record<VoiceModelId, VoiceModelManifest> = {
  dictation: {
    id: 'dictation',
    folder: 'parakeet-tdt-0.6b-v3-int8',
    files: [
      {
        name: 'encoder.int8.onnx',
        url: `${PARAKEET}/encoder.int8.onnx`,
        size: 652_184_281,
        sha256: 'acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247'
      },
      {
        name: 'decoder.int8.onnx',
        url: `${PARAKEET}/decoder.int8.onnx`,
        size: 11_845_275,
        sha256: '179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e'
      },
      {
        name: 'joiner.int8.onnx',
        url: `${PARAKEET}/joiner.int8.onnx`,
        size: 6_355_277,
        sha256: '3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3'
      },
      {
        name: 'tokens.txt',
        url: `${PARAKEET}/tokens.txt`,
        size: 93_939,
        sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d'
      },
      {
        name: 'silero_vad.onnx',
        url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
        size: 643_854,
        sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6'
      }
    ]
  },
  speech: {
    id: 'speech',
    folder: 'kokoro-multi-lang-v1_0',
    files: [
      {
        name: 'model.onnx',
        url: `${KOKORO}/model.onnx`,
        size: 325_560_556,
        sha256: 'b40f62b166ac8164b0627ef48a0b358eda0985e272fb03ef5252e7206305da11'
      },
      {
        name: 'voices.bin',
        url: `${KOKORO}/voices.bin`,
        size: 28_200_960,
        sha256: '1c5a5b983d3d50d8586d437a51f3faa2da7919ce76a013c081e65671a3447c29'
      },
      {
        name: 'tokens.txt',
        url: `${KOKORO}/tokens.txt`,
        size: 687,
        sha256: '6ebb6bb288f20f3ae8d004d3c2ca27697da27c037d75e81a60e2a6a663f95425'
      },
      {
        name: 'lexicon-us-en.txt',
        url: `${KOKORO}/lexicon-us-en.txt`,
        size: 5_956_885,
        sha256: '7daaab53a181be9885b853a8582bf1838186317e5dadacbcef9c426d6fa0da14'
      },
      {
        name: 'espeak-ng-data/phontab',
        url: `${KOKORO}/espeak-ng-data/phontab`,
        size: 55_796,
        sha256: '886f3fa402cb0ba73d483aa8ad000af47a6b7cc06293c75a97913fba68a530f6'
      },
      {
        name: 'espeak-ng-data/phonindex',
        url: `${KOKORO}/espeak-ng-data/phonindex`,
        size: 39_074,
        sha256: '3ca7b8fa3b42624e4b0f152707e7a39245fce569aa99ea47c055d9e622fcf0c4'
      },
      {
        name: 'espeak-ng-data/phondata',
        url: `${KOKORO}/espeak-ng-data/phondata`,
        size: 550_424,
        sha256: '4e0288957874029a8c3c9f41a8f517ad4bf18127046decbdd4b9d1d6807ce3a3'
      },
      {
        name: 'espeak-ng-data/intonations',
        url: `${KOKORO}/espeak-ng-data/intonations`,
        size: 2_040,
        sha256: '3f8af65fd3eda9759a10f021d61361c120871f463515229c925995c7f90918cc'
      },
      {
        name: 'espeak-ng-data/en_dict',
        url: `${KOKORO}/espeak-ng-data/en_dict`,
        size: 166_944,
        sha256: '71bd330ba8a2e3e8076e631508208ef49449d6147c17b7bd2b4b1e1468292e35'
      },
      {
        name: 'espeak-ng-data/es_dict',
        url: `${KOKORO}/espeak-ng-data/es_dict`,
        size: 49_252,
        sha256: '3fa93e251eab80838a2d6207ee58c9c847270a65fe3fae98850e0185b5a2186c'
      },
      {
        name: 'espeak-ng-data/fr_dict',
        url: `${KOKORO}/espeak-ng-data/fr_dict`,
        size: 63_727,
        sha256: 'e399ab924c4d10beef1fc310b30ea56e4ddfd8b4b64b8ed978e9c65394d49b2d'
      },
      {
        name: 'espeak-ng-data/hi_dict',
        url: `${KOKORO}/espeak-ng-data/hi_dict`,
        size: 92_143,
        sha256: '5a68c9532624e57ac845b26ce1e2e5034c4f6353bede46ecbe57e583ec8effd6'
      },
      {
        name: 'espeak-ng-data/it_dict',
        url: `${KOKORO}/espeak-ng-data/it_dict`,
        size: 152_889,
        sha256: '111f968359c9ebe36b107a2565ba9f258bab337d3cbe37e44871980a8f21ce6b'
      },
      {
        name: 'espeak-ng-data/pt_dict',
        url: `${KOKORO}/espeak-ng-data/pt_dict`,
        size: 67_817,
        sha256: '7e8398f15fa4a21db39a213381f28ec0d302b22663c644e865abb61a09c1b004'
      },
      {
        name: 'espeak-ng-data/lang/gmw/en-US',
        url: `${KOKORO}/espeak-ng-data/lang/gmw/en-US`,
        size: 257,
        sha256: '41534c2a22df5dd4f1052ff9e1a33a3ea7bff5a26b5c02bdad5ba8ddb7524704'
      },
      {
        name: 'espeak-ng-data/lang/inc/hi',
        url: `${KOKORO}/espeak-ng-data/lang/inc/hi`,
        size: 23,
        sha256: '3c1c3f916f57f2d6d6cbf7923c0f39a36ac2140e2a69ddffce917d7b8bf3ccab'
      },
      {
        name: 'espeak-ng-data/lang/roa/es',
        url: `${KOKORO}/espeak-ng-data/lang/roa/es`,
        size: 63,
        sha256: '966aa015ea5646d79f0ca4807cf5da7339aabd3782b55cfa5eb0d8c3fc8fc588'
      },
      {
        name: 'espeak-ng-data/lang/roa/fr',
        url: `${KOKORO}/espeak-ng-data/lang/roa/fr`,
        size: 79,
        sha256: '95f44834b48c075dad13eace54d2c98ff79b81aa0074dd67eebaf66c2909eef8'
      },
      {
        name: 'espeak-ng-data/lang/roa/it',
        url: `${KOKORO}/espeak-ng-data/lang/roa/it`,
        size: 109,
        sha256: '0d9069eb9a96db1c55c131b2bb7d1f5255c68fbddc2199ffd3295b52519a3256'
      },
      {
        name: 'espeak-ng-data/lang/roa/pt-BR',
        url: `${KOKORO}/espeak-ng-data/lang/roa/pt-BR`,
        size: 109,
        sha256: '84dd4e34c970fadbe32211eadecfdfaab52432479c0911e43300da88a33398ba'
      }
    ]
  }
}

/** Model folders an earlier SideKick downloaded and no longer uses. */
export const SUPERSEDED_VOICE_FOLDERS = ['supertonic-3-int8-2026-05-11']

const COMPLETE_MARKER = '.complete.json'

export function voiceModelSize(manifest: VoiceModelManifest): number {
  return manifest.files.reduce((total, file) => total + file.size, 0)
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

export type VoiceFetch = (url: string, init: RequestInit) => Promise<Response>

/**
 * Downloads and verifies one model. Files land as `.partial` and resume from
 * where an interrupted download stopped; a file is renamed into place only
 * after its size and hash match the manifest.
 */
export class VoiceModelStore {
  constructor(
    readonly root: string,
    private readonly fetcher: VoiceFetch = (url, init) => fetch(url, init)
  ) {}

  directory(manifest: VoiceModelManifest): string {
    return join(this.root, manifest.folder)
  }

  path(manifest: VoiceModelManifest, name: string): string {
    return join(this.directory(manifest), name)
  }

  /** Cheap check made at startup: the marker plus every file at its expected size. */
  async isInstalled(manifest: VoiceModelManifest): Promise<boolean> {
    const directory = this.directory(manifest)
    try {
      const marker = JSON.parse(await readFile(join(directory, COMPLETE_MARKER), 'utf8')) as {
        files?: string[]
      }
      const expected = manifest.files.map((file) => file.sha256)
      if (JSON.stringify(marker.files) !== JSON.stringify(expected)) return false
    } catch {
      return false
    }
    for (const file of manifest.files) {
      if ((await fileSize(join(directory, file.name))) !== file.size) return false
    }
    return true
  }

  /** Deletes a model folder SideKick no longer uses. Only a plain folder name is accepted. */
  async removeFolder(folder: string): Promise<void> {
    if (!/^[\w.-]+$/.test(folder) || folder === '.' || folder === '..') return
    await rm(join(this.root, folder), { recursive: true, force: true })
  }

  async initialState(manifest: VoiceModelManifest): Promise<VoiceModelState> {
    const totalBytes = voiceModelSize(manifest)
    if (await this.isInstalled(manifest)) {
      return { status: 'ready', receivedBytes: totalBytes, totalBytes }
    }
    let receivedBytes = 0
    for (const file of manifest.files) {
      const done = this.path(manifest, file.name)
      receivedBytes += existsSync(done) ? await fileSize(done) : await fileSize(`${done}.partial`)
    }
    return { status: 'missing', receivedBytes: Math.min(receivedBytes, totalBytes), totalBytes }
  }

  async download(
    manifest: VoiceModelManifest,
    onProgress: (receivedBytes: number) => void,
    signal: AbortSignal
  ): Promise<void> {
    const directory = this.directory(manifest)
    await mkdir(directory, { recursive: true })
    let completedBytes = 0
    for (const file of manifest.files) {
      const target = join(directory, file.name)
      if ((await fileSize(target)) === file.size) {
        completedBytes += file.size
        onProgress(completedBytes)
        continue
      }
      // Some files sit in a folder of their own, such as espeak-ng-data/lang/roa.
      await mkdir(dirname(target), { recursive: true })
      await this.downloadFile(file, target, (bytes) => onProgress(completedBytes + bytes), signal)
      completedBytes += file.size
    }
    await writeFile(
      join(directory, COMPLETE_MARKER),
      JSON.stringify({ files: manifest.files.map((file) => file.sha256) })
    )
  }

  private async downloadFile(
    file: VoiceModelFile,
    target: string,
    onProgress: (bytes: number) => void,
    signal: AbortSignal
  ): Promise<void> {
    const partial = `${target}.partial`
    let offset = await fileSize(partial)
    if (offset > file.size) {
      await rm(partial, { force: true })
      offset = 0
    }
    if (offset < file.size) {
      const response = await this.fetcher(file.url, {
        signal,
        headers: offset > 0 ? { Range: `bytes=${offset}-` } : {}
      })
      if (!response.ok || !response.body) {
        throw new Error(`Download of ${file.name} failed (HTTP ${response.status})`)
      }
      // A server that ignores the range sends the whole file again.
      if (offset > 0 && response.status !== 206) offset = 0
      let received = offset
      onProgress(received)
      const body = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream)
      body.on('data', (chunk: Buffer) => {
        received += chunk.length
        onProgress(received)
      })
      await pipeline(body, createWriteStream(partial, { flags: offset > 0 ? 'a' : 'w' }), {
        signal
      })
    }
    if ((await fileSize(partial)) !== file.size || (await sha256Of(partial)) !== file.sha256) {
      await rm(partial, { force: true })
      throw new Error(`Downloaded ${file.name} did not match its expected contents`)
    }
    await rename(partial, target)
  }
}
