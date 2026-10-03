/**
 * Where browser screenshots and other renderer-visible images are kept. Set once at startup by
 * the artifact protocol, which serves the folder; held apart from it so services and their tests
 * do not load Electron to know the path.
 */
let root: string | null = null

export function setBrowserArtifactRoot(path: string): void {
  root = path
}

export function browserArtifactRoot(): string | null {
  return root
}
