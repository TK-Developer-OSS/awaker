// Copyright 2026 TK <tk.oss.developer@gmail.com>
// SPDX-License-Identifier: Apache-2.0
// Generated with Claude Code (https://claude.com/claude-code)

/**
 * Options: the model behind the Options panel. No DOM here, so it is unit-tested.
 *
 * Every feature that wants a setting registers an `OptionSection` (its fields, defaults and an
 * `apply` that makes the values take effect). The panel is built from the registered sections, and
 * the whole set is stored in ONE file (fixed name, in the user-data folder): pressing OK writes
 * it, and it is read and applied automatically at every start. To add an option, add a field to a
 * section (or a new section); nothing else in the panel or the file code changes.
 *
 * The file is forgiving on purpose: a missing key falls back to its default, an unknown key or a
 * value that no longer fits its field is dropped, and unknown sections are kept untouched (they may
 * belong to a newer / older version of the app). A broken or absent file just means "defaults".
 */

export type OptionValue = string | number | boolean

/** Show the field only while another field of the same section has one of these values. */
export interface ShowWhen {
  key: string
  in: string[]
}

export interface ChoiceField {
  key: string
  type: 'choice'
  showWhen?: ShowWhen
  label: string
  hint?: string
  choices: { value: string; label: string }[]
}
export interface NumberField {
  key: string
  type: 'number'
  showWhen?: ShowWhen
  label: string
  hint?: string
  min: number
  max: number
  step?: number
  unit?: string
}
export interface ToggleField {
  key: string
  type: 'toggle'
  showWhen?: ShowWhen
  label: string
  hint?: string
}
export interface TextField {
  key: string
  type: 'text'
  showWhen?: ShowWhen
  label: string
  hint?: string
  placeholder?: string
  maxLength: number
  /** A text area of `rows` lines instead of a one-line input (long texts such as a system prompt). */
  multiline?: boolean
  rows?: number
}
export type OptionField = ChoiceField | NumberField | ToggleField | TextField

export interface OptionSection {
  /** Stable id: the key in the file. Do not rename once released. */
  id: string
  title: string
  description?: string
  fields: OptionField[]
  /** Draw the fields (and the preview) inside a bordered box of this fixed height, so the panel does not jump. */
  box?: { height: number }
  defaults: Record<string, OptionValue>
  /** Make the values take effect (called live while editing, and at start-up). Must be idempotent. */
  apply(values: Record<string, OptionValue>): void
  /** Optional live preview drawn inside the section in the panel. */
  preview?(host: HTMLElement, values: Record<string, OptionValue>): void
}

/** Is this field shown for these values? (A field without `showWhen` always is.) */
export function isFieldVisible(field: OptionField, values: Record<string, OptionValue>): boolean {
  const w = field.showWhen
  return !w || w.in.includes(String(values[w.key]))
}

export type OptionValues = Record<string, Record<string, OptionValue>>

export const OPTIONS_FILE_VERSION = 1

export interface OptionsFile {
  version: number
  values: OptionValues
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** One field's value from a raw (untrusted) value: valid → as is / clamped, otherwise the default. */
export function normalizeField(field: OptionField, raw: unknown, fallback: OptionValue): OptionValue {
  switch (field.type) {
    case 'choice':
      return typeof raw === 'string' && field.choices.some((c) => c.value === raw) ? raw : fallback
    case 'number': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback
      const v = Math.min(field.max, Math.max(field.min, raw))
      return field.step ? Math.round(v / field.step) * field.step : v
    }
    case 'toggle':
      return typeof raw === 'boolean' ? raw : fallback
    case 'text':
      return typeof raw === 'string' ? raw.trim().slice(0, field.maxLength) : fallback
  }
}

/** A whole section's values from a raw object: every field present and valid. */
export function normalizeSection(section: OptionSection, raw: unknown): Record<string, OptionValue> {
  const src = isRecord(raw) ? raw : {}
  const out: Record<string, OptionValue> = {}
  for (const f of section.fields) out[f.key] = normalizeField(f, src[f.key], section.defaults[f.key])
  return out
}

/** The defaults of every registered section. */
export function defaultValues(sections: OptionSection[]): OptionValues {
  const out: OptionValues = {}
  for (const s of sections) out[s.id] = { ...s.defaults }
  return out
}

/**
 * Values from a parsed options file. Anything unreadable gives the defaults for that section;
 * sections the app does not know are returned in `extra` so a save does not throw them away.
 */
export function parseOptions(
  sections: OptionSection[],
  json: unknown
): { values: OptionValues; extra: Record<string, unknown> } {
  const values: OptionValues = {}
  const extra: Record<string, unknown> = {}
  const file = isRecord(json) ? json : {}
  const raw = isRecord(file['values']) ? (file['values'] as Record<string, unknown>) : {}
  for (const s of sections) values[s.id] = normalizeSection(s, raw[s.id])
  for (const [k, v] of Object.entries(raw)) if (!sections.some((s) => s.id === k)) extra[k] = v
  return { values, extra }
}

export function serializeOptions(values: OptionValues, extra: Record<string, unknown> = {}): OptionsFile {
  return { version: OPTIONS_FILE_VERSION, values: { ...extra, ...values } as OptionValues }
}

/** Fields whose value differs from the default (for a "modified" mark in the panel). */
export function isDefault(section: OptionSection, values: Record<string, OptionValue>): boolean {
  return section.fields.every((f) => values[f.key] === section.defaults[f.key])
}
