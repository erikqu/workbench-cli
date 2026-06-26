// Stable fixture for the Workbench screenshot suite's code-editor checks.
// This file is intentionally decoupled from the application source tree and is
// excluded from formatting so the editor screenshots stay pixel-deterministic
// across reorganization and reformatting passes. Do not move or reformat it.
import { readFileSync } from "node:fs"
import { join } from "node:path"

export const FIXTURE_MARKER = "WORKBENCH_EDITOR_FIXTURE"

export interface SampleConfig {
  name: string
  count: number
  enabled: boolean
  tags: string[]
}

const DEFAULT_CONFIG: SampleConfig = {
  name: "sample",
  count: 0,
  enabled: true,
  tags: ["editor", "fixture", "screenshot"],
}

export function loadSampleConfig(dir: string): SampleConfig {
  try {
    const raw = readFileSync(join(dir, "sample.json"), "utf8")
    const parsed = JSON.parse(raw) as Partial<SampleConfig>
    return { ...DEFAULT_CONFIG, ...parsed }
  } catch {
    return DEFAULT_CONFIG
  }
}

export class SampleCounter {
  private value = 0

  constructor(private readonly step: number = 1) {}

  increment(): number {
    this.value += this.step
    return this.value
  }

  reset(): void {
    this.value = 0
  }

  get current(): number {
    return this.value
  }
}

export function summarize(config: SampleConfig): string {
  const status = config.enabled ? "enabled" : "disabled"
  return `${config.name}: ${config.count} (${status}) [${config.tags.join(", ")}]`
}

// A long tail of declarations so the bottom sentinel sits below the fold and a
// successful scroll is required to reveal it.
const FILLER_A = "alpha"
const FILLER_B = "bravo"
const FILLER_C = "charlie"
const FILLER_D = "delta"
const FILLER_E = "echo"
const FILLER_F = "foxtrot"

export const FILLERS = [FILLER_A, FILLER_B, FILLER_C, FILLER_D, FILLER_E, FILLER_F]

export const SCROLL_TARGET_SENTINEL = "scrolled-to-bottom-of-sample"
