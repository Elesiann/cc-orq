// Plain JavaScript on purpose: this file has to load on a Node that cannot load TypeScript, which is the Node it refuses.
// Node runs .ts files without a build step from 22.18 on.
const MINIMUM = [22, 18, 0]

/** The one stderr line for a Node older than 22.18, given a version such as process.versions.node; null when it is new enough. */
export function nodeVersionRefusal(version) {
  const found = version.split('.').map((part) => Number.parseInt(part, 10))
  for (let i = 0; i < MINIMUM.length; i += 1) {
    const have = found[i] ?? 0
    const need = MINIMUM[i]
    if (have === need) continue
    if (have > need) return null
    return `cc-orq: the orq server needs Node 22.18 or newer, found ${version}`
  }
  return null
}
