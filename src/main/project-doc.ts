// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'

/**
 * The project document the user is working on: the file they opened or saved as. Save writes back to
 * it; with none (nothing opened or saved-as yet, or after New) Save asks where, like Save As. The path is kept
 * in `<userData>/last-document.json` so the next start reopens the same file — opening a file never
 * copies it anywhere else. With no document to reopen, the app starts on a blank project.
 */
let docPath: string | null = null
let pointerFile: string | null = null
let onChange: (path: string | null) => void = () => {}

export function initProjectDoc(userData: string, changed: (path: string | null) => void): void {
  pointerFile = join(userData, 'last-document.json')
  onChange = changed
}

export const projectDocPath = (): string | null => docPath

/** Window title for the current document. */
export const projectDocTitle = (): string => (docPath ? `${basename(docPath)} — Awaker` : 'Awaker DAW over GPU')

/** Set (or clear, for a new project) the current document and remember it for the next start. */
export async function setProjectDoc(path: string | null): Promise<void> {
  docPath = path
  onChange(path)
  if (!pointerFile) return
  try {
    await mkdir(dirname(pointerFile), { recursive: true })
    await writeFile(pointerFile, JSON.stringify({ path }), 'utf8')
  } catch {
    /* only the reopen-on-start convenience is lost */
  }
}

/** On start: the document that was open last time, if it is still readable. */
export async function restoreProjectDoc(): Promise<{ path: string; data: unknown } | null> {
  if (!pointerFile) return null
  try {
    const p = (JSON.parse(await readFile(pointerFile, 'utf8')) as { path?: unknown }).path
    if (typeof p !== 'string' || !p) return null
    const data = JSON.parse(await readFile(p, 'utf8'))
    docPath = p
    onChange(p)
    return { path: p, data }
  } catch {
    return null // moved / deleted / unreadable: fall back to the default project
  }
}
