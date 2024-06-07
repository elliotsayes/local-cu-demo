import { fetchProcessDef } from "./result"

export type Tag = {
  name: string
  value: string
}

export type ProcessDef = Awaited<ReturnType<typeof fetchProcessDef>>
