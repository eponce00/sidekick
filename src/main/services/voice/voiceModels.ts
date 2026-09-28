import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
const SUPERTONIC =
  'https://huggingface.co/csukuangfj2/sherpa-onnx-supertonic-3-tts-int8-2026-05-11/resolve/cca5a0e6c96e1d2c720986bf7e75fcc81dee3ae4'

/**
 * Pinned to exact revisions and hashes: a model that changes upstream is
 * refused rather than loaded. Parakeet TDT 0.6B v3 (CC-BY-4.0, NVIDIA) for
 * dictation with Silero VAD (MIT) to find speech; Supertonic 3 (OpenRAIL-M,
 * Supertone) to read replies aloud.
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
    folder: 'supertonic-3-int8-2026-05-11',
    files: [
      {
        name: 'duration_predictor.int8.onnx',
        url: `${SUPERTONIC}/duration_predictor.int8.onnx`,
        size: 3_700_147,
        sha256: 'c3eb91414d5ff8a7a239b7fe9e34e7e2bf8a8140d8375ffb14718b1c639325db'
      },
      {
        name: 'text_encoder.int8.onnx',
        url: `${SUPERTONIC}/text_encoder.int8.onnx`,
        size: 36_416_150,
        sha256: 'c7befd5ea8c3119769e8a6c1486c4edc6a3bc8365c67621c881bbb774b9902ff'
      },
      {
        name: 'vector_estimator.int8.onnx',
        url: `${SUPERTONIC}/vector_estimator.int8.onnx`,
        size: 78_400_833,
        sha256: '20cd86fa5c6effedfda0e7cffe5b0569ca401c440a0c3a1d72bf39286c0db3fd'
      },
      {
        name: 'vocoder.int8.onnx',
        url: `${SUPERTONIC}/vocoder.int8.onnx`,
        size: 25_991_073,
        sha256: 'e923d60f53f95eb1ce235f1dc33ec56d9c057823c96fa6f8acf98f32b0da6152'
      },
      {
        name: 'tts.json',
        url: `${SUPERTONIC}/tts.json`,
        size: 8_253,
        sha256: '42078d3aef1cd43ab43021f3c54f47d2d75ceb4e75f627f118890128b06a0d09'
      },
      {
        name: 'unicode_indexer.bin',
        url: `${SUPERTONIC}/unicode_indexer.bin`,
        size: 262_144,
        sha256: '8402ca48e5189a8950138580b0fff64db6f072f24ac07cd54ba8b2fbb9883b30'
      },
      {
        name: 'voice.bin',
        url: `${SUPERTONIC}/voice.bin`,
        size: 517_168,
        sha256: '67d5209b0ee8ce6c74105ffbe12fe6a7628aea3b4ba2fcb308a4a67938a93ce8'
      }
    ]
  }
}

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
